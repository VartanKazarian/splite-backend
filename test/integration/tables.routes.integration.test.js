const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * The table endpoints, over HTTP, against a real Postgres.
 *
 * The behaviour under test is a property of the unique index and of what
 * "delete" means here, so none of it can be shown without a database. Deleting
 * a table in the panel is `PATCH { active: false }`: the row survives, still
 * holding its name, while vanishing from every screen that filters on
 * `active`. Creating that name again was refused as taken -- by a table nobody
 * could see, with nothing in the panel able to undo it.
 */
describe('table routes over HTTP', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let token;
  let seq = 0;

  const request = async (method, path, { body, auth = true } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // A name of its own per test, so one test's leftovers cannot decide another's
  // result -- the whole point here is what a *pre-existing* row does.
  const uniqueName = prefix => `${prefix} ${Date.now() % 100000}-${++seq}`;

  // Every request here comes from 127.0.0.1 against an app-level limit of 120 a
  // minute. The limiter is right; the harness is what shares one address.
  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1',
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );

  beforeEach(clearIpRateLimits);

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Tables Tenant' });

    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
      [restaurant.id, `tables-${restaurant.id}@example.com`]
    );
    // Minted rather than obtained by logging in: /api/v1/auth allows 10 requests
    // a minute per IP and this suite shares 127.0.0.1 with every other.
    token = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('creates a table again after it was deleted, and gives back the same one', async () => {
    // The reported bug, end to end. Deleting is a deactivation, so the name
    // stayed held by an invisible row and creating it again was a dead end.
    const name = uniqueName('Mesa');

    const created = await request('POST', '/api/v1/tables', { body: { name } });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const deleted = await request('PATCH', `/api/v1/tables/${created.body.id}`, {
      body: { active: false }
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.active, false);

    const again = await request('POST', '/api/v1/tables', { body: { name } });
    assert.equal(again.status, 200, `expected the table back, got ${JSON.stringify(again.body)}`);
    assert.equal(again.body.active, true);

    // The same row, not a new one. This is what keeps the printed QR working:
    // guest lookups require `active = true`, so the sticker on that table died
    // with the deactivation and comes back with the table. A new id would leave
    // it dead with nothing on screen to say why.
    assert.equal(again.body.id, created.body.id, 'the table came back, rather than being replaced');
    assert.equal(again.body.createdAt, created.body.createdAt, 'it kept its history');
  });

  it('still refuses a name an active table is using', async () => {
    const name = uniqueName('Mesa');
    const created = await request('POST', '/api/v1/tables', { body: { name } });
    assert.equal(created.status, 201);

    const duplicate = await request('POST', '/api/v1/tables', { body: { name } });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'TABLE_NAME_TAKEN');
  });

  it('records a reactivation as its own event, not as a creation', async () => {
    // A table coming back and a table opening for the first time are different
    // things, and the audit log is where the difference has to be legible.
    const name = uniqueName('Mesa');
    const created = await request('POST', '/api/v1/tables', { body: { name } });
    await request('PATCH', `/api/v1/tables/${created.body.id}`, { body: { active: false } });
    await request('POST', '/api/v1/tables', { body: { name } });

    const { rows } = await db.query(
      `SELECT action FROM audit_logs
        WHERE restaurant_id = $1 AND resource_id = $2
        ORDER BY created_at ASC, action ASC`,
      [restaurant.id, created.body.id]
    );
    assert.deepEqual(
      rows.map(r => r.action).filter(a => a.startsWith('TABLE_')),
      ['TABLE_CREATED', 'TABLE_UPDATED', 'TABLE_REACTIVATED']
    );
  });

  it('brings a deleted table back through the bulk endpoint too', async () => {
    // Asking for N tables and being handed N-1, with nothing saying which is
    // missing or why, is the deletion surprising the restaurant a second time.
    const prefix = uniqueName('Salon');
    const first = await request('POST', '/api/v1/tables/bulk', { body: { count: 3, prefix } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.created, 3);

    const second = first.body.data.find(t => t.name === `${prefix} 2`);
    await request('PATCH', `/api/v1/tables/${second.id}`, { body: { active: false } });

    const again = await request('POST', '/api/v1/tables/bulk', { body: { count: 3, prefix } });
    assert.equal(again.status, 201);
    assert.equal(again.body.created, 0, 'nothing new was needed');
    assert.equal(again.body.reactivated, 1, 'the deleted one came back');
    assert.equal(again.body.alreadyExisted, 2);

    const back = again.body.data.find(t => t.name === `${prefix} 2`);
    assert.equal(back.id, second.id, 'the same table, not a replacement');
  });

  it('leaves a deactivated table outside the requested range alone', async () => {
    // The range is what the restaurant asked for. A table retired above it is
    // not part of the request and must not be resurrected by a count.
    const prefix = uniqueName('Terraza');
    const made = await request('POST', '/api/v1/tables/bulk', { body: { count: 4, prefix } });
    const fourth = made.body.data.find(t => t.name === `${prefix} 4`);
    await request('PATCH', `/api/v1/tables/${fourth.id}`, { body: { active: false } });

    await request('POST', '/api/v1/tables/bulk', { body: { count: 2, prefix } });

    const { rows } = await db.query(
      'SELECT active FROM tables WHERE id = $1',
      [fourth.id]
    );
    assert.equal(rows[0].active, false, 'still retired');
  });

  it('says which table is in the way when a rename collides with a deleted one', async () => {
    // Renaming cannot resolve itself by reviving the other row -- that would
    // leave two tables wanting one name -- so it stays a refusal. What it can
    // do is name the blocker, which may be invisible on every screen the
    // person renaming is looking at.
    const taken = uniqueName('Mesa');
    const other = uniqueName('Mesa');

    const blocker = await request('POST', '/api/v1/tables', { body: { name: taken } });
    await request('PATCH', `/api/v1/tables/${blocker.body.id}`, { body: { active: false } });
    const mover = await request('POST', '/api/v1/tables', { body: { name: other } });

    const renamed = await request('PATCH', `/api/v1/tables/${mover.body.id}`, {
      body: { name: taken }
    });
    assert.equal(renamed.status, 409);
    assert.equal(renamed.body.error.code, 'TABLE_NAME_TAKEN');
    assert.equal(renamed.body.error.details.tableId, blocker.body.id);
    assert.equal(renamed.body.error.details.active, false);
    assert.match(renamed.body.error.message, /deactivated/);
  });

  it('keeps the bills a table had before it was deleted', async () => {
    // The reason there is no DELETE at all: a table carries history. Reviving
    // the row rather than minting a new one is what keeps that history
    // attached to the table the restaurant sees.
    const name = uniqueName('Mesa');
    const created = await request('POST', '/api/v1/tables', { body: { name } });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: created.body.id, totalDue: 5000, totalDueVes: 5000
    });
    await db.query("UPDATE bills SET status = 'CLOSED' WHERE id = $1", [bill.id]);

    await request('PATCH', `/api/v1/tables/${created.body.id}`, { body: { active: false } });
    const again = await request('POST', '/api/v1/tables', { body: { name } });
    assert.equal(again.body.id, created.body.id);

    const { rows } = await db.query('SELECT table_id FROM bills WHERE id = $1', [bill.id]);
    assert.equal(rows[0].table_id, created.body.id, 'the old bill still points at it');
  });
});
