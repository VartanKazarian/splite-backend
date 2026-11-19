const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const config = require('../../src/config');

/**
 * Lo que el plano de mesas sabe de cada mesa (R12).
 *
 * Dos cosas que el plano no podía decir: que alguien de la mesa está ahora en
 * su banco pagando (una reserva viva), y que hay un primer pedido esperando
 * aprobación -- en una mesa que, sin cuenta abierta, salía como «Libre».
 */
describe('the floor shows payments in progress and orders awaiting approval', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let staff;
  let seq = 0;
  const mySessions = [];

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

  const newTable = async () => {
    const created = await fixtures.createTable(restaurant.id, { name: `FS${++seq}` });
    return (await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id])).rows[0];
  };
  const scan = async (table) => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: table.restaurant_id, nonce: table.qr_nonce,
      iat: now, ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const res = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    mySessions.push(res.body.sessionId);
    return { session: res.body.sessionId, token: res.body.guestToken };
  };
  const floorRow = async (table) => {
    const res = await request('GET', '/api/v1/tables/floor', { token: staff });
    assert.equal(res.status, 200);
    return res.body.data.find(t => t.id === table.id);
  };

  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:order:*'),
      ...await redis.keys('guest:qrctx:*'), ...mySessions.map(id => `guest:rl:${id}`)
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Floor Status Tenant' });
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'WAITER') RETURNING id`,
      [restaurant.id, `floor-${restaurant.id}@example.com`]);
    staff = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'WAITER' });
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
      await db.query('DELETE FROM guest_orders WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payment_holds WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('a quiet table reports nothing in progress', async () => {
    const free = await newTable();
    const row = await floorRow(free);
    assert.equal(row.heldOrders, 0);
    assert.equal(row.openBill, null);

    const busy = await newTable();
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: busy.id, totalDue: 50000, totalDueVes: 50000 });
    assert.equal((await floorRow(busy)).openBill.payingNow, 0);
  });

  it('a diner in their bank app shows as paying now, and stops when the hold goes', async () => {
    const table = await newTable();
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 50000, totalDueVes: 50000 });
    const ana = await scan(table);
    const hold = await request('POST', '/api/v1/guest/bill/holds', { ...ana, body: { amountVes: '20000' } });
    assert.equal(hold.status, 201, JSON.stringify(hold.body));
    assert.equal((await floorRow(table)).openBill.payingNow, 1);

    await db.query(`UPDATE payment_holds SET expires_at = NOW() - INTERVAL '1 second' WHERE restaurant_id = $1`, [restaurant.id]);
    assert.equal((await floorRow(table)).openBill.payingNow, 0, 'an expired hold is not someone paying');
  });

  it('a held first order shows on a table with no bill, and not once it expires', async () => {
    await db.query('UPDATE restaurants SET approve_new_phone_orders = true WHERE id = $1', [restaurant.id]);
    try {
      const table = await newTable();
      const ana = await scan(table);
      const product = (await db.query(
        `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
         VALUES ($1, $2, 1500, 'VES', true) RETURNING id`, [restaurant.id, `P${++seq}`])).rows[0].id;
      const placed = await request('POST', '/api/v1/guest/bill/orders', {
        ...ana, body: { items: [{ productId: product, quantity: 1 }] }
      });
      assert.equal(placed.body.status, 'HELD');

      const row = await floorRow(table);
      assert.equal(row.openBill, null, 'still no bill');
      assert.equal(row.heldOrders, 1, 'but someone is waiting at it');

      await db.query(
        `UPDATE guest_orders SET created_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
        [placed.body.orderId, config.guest.heldOrderTimeoutSeconds + 60]);
      assert.equal((await floorRow(table)).heldOrders, 0);
    } finally {
      await db.query('UPDATE restaurants SET approve_new_phone_orders = false WHERE id = $1', [restaurant.id]);
    }
  });
});
