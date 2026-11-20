const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const config = require('../../src/config');

/*
 * La propina que la mesa trae marcada la elige el restaurante: dueño o
 * encargado la ponen en el panel, y el comensal la recibe con la cuenta.
 */
describe('default tip: a restaurant setting the diner receives with the bill', { skip }, () => {
  let server;
  let base;
  let restaurant;
  const tokens = {};
  const mySessions = [];
  let seq = 0;

  const request = async (method, path, { body, session, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { 'x-guest-session': session } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const dinerAtTable = async () => {
    const created = await fixtures.createTable(restaurant.id, { name: `P${++seq}` });
    const table = (await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id])).rows[0];
    await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 4000000, totalDueVes: 4000000
    });
    const now = Math.floor(Date.now() / 1000);
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: table.restaurant_id, nonce: table.qr_nonce, iat: now,
      ...(config.qrTtlSeconds > 0 ? { exp: now + config.qrTtlSeconds } : {})
    });
    const scanned = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(scanned.status, 201, JSON.stringify(scanned.body));
    mySessions.push(scanned.body.sessionId);
    return { session: scanned.body.sessionId, token: scanned.body.guestToken };
  };

  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:qrctx:*'),
      ...mySessions.map(id => `guest:rl:${id}`)
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Tip Tenant' });
    for (const role of ['OWNER', 'MANAGER', 'WAITER']) {
      const id = (await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [restaurant.id, `tip-${role.toLowerCase()}-${restaurant.id}@example.com`, role])).rows[0].id;
      tokens[role] = signAccessToken({ id, restaurantId: restaurant.id, role });
    }
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(clearRateLimits);

  after(async () => {
    await clearRateLimits();
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('starts at 10 %, as every table showed before the setting existed', async () => {
    const res = await request('GET', '/api/v1/account', { token: tokens.OWNER });
    assert.equal(res.status, 200);
    assert.equal(res.body.defaultTipPct, 10);
    const diner = await dinerAtTable();
    const bill = await request('GET', '/api/v1/guest/bill', diner);
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    assert.equal(bill.body.defaultTipPct, 10);
  });

  it('owner and manager change it; the diner gets it with the bill; it is audited', async () => {
    const set = await request('PATCH', '/api/v1/account', { token: tokens.MANAGER, body: { defaultTipPct: 0 } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.defaultTipPct, 0);
    // Cambiar otra cosa no toca la propina.
    const renamed = await request('PATCH', '/api/v1/account', { token: tokens.OWNER, body: { name: 'Tip Tenant 2' } });
    assert.equal(renamed.body.defaultTipPct, 0);

    const diner = await dinerAtTable();
    const bill = await request('GET', '/api/v1/guest/bill', diner);
    assert.equal(bill.body.defaultTipPct, 0);

    const again = await request('PATCH', '/api/v1/account', { token: tokens.OWNER, body: { defaultTipPct: 15 } });
    assert.equal(again.body.defaultTipPct, 15);
    const audit = await db.query(
      `SELECT details FROM audit_logs WHERE restaurant_id = $1 AND action = 'DEFAULT_TIP_CHANGED'
        ORDER BY created_at`, [restaurant.id]);
    assert.deepEqual(audit.rows.map(r => r.details.defaultTipPct), [0, 15]);
  });

  it('only the four the diner can tap, and not by a waiter', async () => {
    for (const value of [12, -10, 100, 'diez']) {
      const res = await request('PATCH', '/api/v1/account', { token: tokens.OWNER, body: { defaultTipPct: value } });
      assert.equal(res.status, 400, `value ${JSON.stringify(value)}`);
    }
    const waiter = await request('PATCH', '/api/v1/account', { token: tokens.WAITER, body: { defaultTipPct: 20 } });
    assert.equal(waiter.status, 403);
  });
});
