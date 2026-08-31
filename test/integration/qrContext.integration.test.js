const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signQrPayload } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * The public landing a physical code leads to, over HTTP.
 *
 * Every rejection is the same `QR_INVALID`, and the sameness is the point: a
 * code stuck to a table is read by strangers, so "no such table" and "wrong
 * nonce" must not be tellable apart. Asserting only the code would miss a
 * regression that leaked the difference through the message, so these compare
 * the messages too.
 */
describe('guest QR context over HTTP', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let table;

  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const qrFor = (over = {}) => signQrPayload({
    v: 1,
    tableId: table.id,
    restaurantId: restaurant.id,
    nonce: table.qr_nonce,
    ...over
  });

  const sessionCount = async () => {
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM guest_sessions WHERE restaurant_id = $1',
      [restaurant.id]
    );
    return rows[0].n;
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'QR Context Tenant' });
    const { rows } = await db.query(
      `INSERT INTO tables (restaurant_id, name) VALUES ($1, 'Mesa 6')
       RETURNING id, name, qr_nonce`,
      [restaurant.id]
    );
    table = rows[0];

    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM guest_sessions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM bills WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM tables WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await closeRedis();
    await db.close();
  });

  it('resolves a printed code without creating a session', async () => {
    const sessionsBefore = await sessionCount();

    const res = await post('/api/v1/guest/qr/context', { qrToken: qrFor() });

    assert.equal(res.status, 200);
    assert.equal(res.body.restaurant.id, restaurant.id);
    assert.equal(res.body.restaurant.name, 'QR Context Tenant');
    assert.equal(res.body.table.name, 'Mesa 6');
    assert.equal(res.body.hasOpenBill, false);

    // The whole reason the route exists: reading the menu must not cost a
    // session.
    assert.equal(await sessionCount(), sessionsBefore);
  });

  it('reports an open bill once there is one, without the amount', async () => {
    await db.query(
      `INSERT INTO bills (restaurant_id, table_id, status, currency)
       VALUES ($1, $2, 'OPEN', 'VES')`,
      [restaurant.id, table.id]
    );

    const res = await post('/api/v1/guest/qr/context', { qrToken: qrFor() });

    assert.equal(res.status, 200);
    assert.equal(res.body.hasOpenBill, true);
    // What the table owes stays behind the session.
    const serialised = JSON.stringify(res.body).toLowerCase();
    for (const leaked of ['total', 'amount', 'due', 'payout']) {
      assert.ok(!serialised.includes(leaked), `${leaked} must not reach an unauthenticated caller`);
    }
  });

  it('refuses a rotated nonce exactly as it refuses an unknown table', async () => {
    const rotated = await post('/api/v1/guest/qr/context', {
      qrToken: qrFor({ nonce: '11111111-2222-4333-8444-555555555555' })
    });
    const unknown = await post('/api/v1/guest/qr/context', {
      qrToken: qrFor({ tableId: '99999999-2222-4333-8444-555555555555' })
    });

    assert.equal(rotated.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(rotated.body.error.code, 'QR_INVALID');
    assert.equal(unknown.body.error.code, 'QR_INVALID');
    // Indistinguishable, message included.
    assert.equal(rotated.body.error.message, unknown.body.error.message);
  });

  it('refuses a deactivated table', async () => {
    await db.query('UPDATE tables SET active = false WHERE id = $1', [table.id]);
    try {
      const res = await post('/api/v1/guest/qr/context', { qrToken: qrFor() });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'QR_INVALID');
    } finally {
      await db.query('UPDATE tables SET active = true WHERE id = $1', [table.id]);
    }
  });

  it('refuses a forged signature', async () => {
    const res = await post('/api/v1/guest/qr/context', { qrToken: `${qrFor()}tampered` });

    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'QR_INVALID');
  });

  it('still mints a session when the diner asks for the bill', async () => {
    // The context route replaces nothing: the existing flow is reached from the
    // landing, and this is the branch that takes a session.
    const sessionsBefore = await sessionCount();

    const res = await post('/api/v1/guest/sessions', { qrToken: qrFor() });

    assert.equal(res.status, 201);
    assert.ok(res.body.sessionId);
    assert.equal(await sessionCount(), sessionsBefore + 1);
  });
});
