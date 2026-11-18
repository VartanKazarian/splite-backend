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
 * El primer pedido de un teléfono nuevo, aprobado por la sala.
 *
 * El QR está pegado a la mesa: cualquiera que lo fotografíe puede pedir desde
 * fuera, o abrir una cuenta en una mesa vacía, como broma. Con el ajuste
 * encendido, el primer pedido de cada sesión espera; aprobado uno, esa sesión
 * pide sin esperar; rechazado, no pide más sin volver a escanear.
 */
describe('approval of the first order from a new phone', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let owner;
  let waiter;
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

  const mint = async (role) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3) RETURNING id`,
      [restaurant.id, `${role.toLowerCase()}-${++seq}-${restaurant.id}@example.com`, role]);
    return signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role });
  };

  const newTable = async () => {
    const created = await fixtures.createTable(restaurant.id, { name: `AP${++seq}` });
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
  const product = async (price = 1500) => (await db.query(
    `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
     VALUES ($1, $2, $3, 'VES', true) RETURNING id`, [restaurant.id, `P${++seq}`, price])).rows[0].id;
  const order = async (diner, productId, quantity = 1) => request('POST', '/api/v1/guest/bill/orders', {
    ...diner, body: { items: [{ productId: productId ?? await product(), quantity }] }
  });
  const openBillOn = async (table) => (await db.query(
    "SELECT id FROM bills WHERE table_id = $1 AND status = 'OPEN'", [table.id])).rows[0]?.id ?? null;
  const linesOn = async (billId) => (await db.query(
    'SELECT count(*)::int AS n FROM bill_items WHERE bill_id = $1', [billId])).rows[0].n;
  const setApproval = (on, token = owner) =>
    request('PATCH', '/api/v1/orders/settings', { token, body: { approveNewPhones: on } });

  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:order:*'),
      ...await redis.keys('guest:qrctx:*'), ...await redis.keys('orders:*'),
      ...mySessions.map(id => `guest:rl:${id}`)
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    await clearRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Order Approval Tenant' });
    owner = await mint('OWNER');
    waiter = await mint('WAITER');
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await clearRateLimits();
    await db.query('UPDATE restaurants SET approve_new_phone_orders = true WHERE id = $1', [restaurant.id]);
  });

  after(async () => {
    await clearRateLimits();
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM guest_orders WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('is off by default; only an owner or manager changes it', async () => {
    const fresh = await fixtures.createRestaurant({ name: 'Approval Default Tenant' });
    try {
      const flag = (await db.query(
        'SELECT approve_new_phone_orders FROM restaurants WHERE id = $1', [fresh.id])).rows[0];
      assert.equal(flag.approve_new_phone_orders, false);
    } finally {
      await fixtures.destroyRestaurant(fresh.id);
    }

    assert.equal((await setApproval(false, waiter)).status, 403);
    const off = await setApproval(false);
    assert.equal(off.status, 200);
    assert.deepEqual(off.body, { approveNewPhones: false });
    assert.deepEqual((await request('GET', '/api/v1/orders/settings', { token: waiter })).body,
      { approveNewPhones: false });
    assert.equal((await request('PATCH', '/api/v1/orders/settings',
      { token: owner, body: { approveNewPhones: 'yes' } })).status, 400);
  });

  it('when off, orders go straight onto the bill as before', async () => {
    await setApproval(false);
    const table = await newTable();
    const placed = await order(await scan(table));
    assert.equal(placed.status, 201);
    assert.equal(placed.body.status, 'PLACED');
    assert.equal(await linesOn(await openBillOn(table)), 1);
  });

  it('a first order is held: nothing reaches a bill and an empty table stays empty', async () => {
    const table = await newTable();
    const ana = await scan(table);
    const held = await order(ana, null, 2);
    assert.equal(held.status, 201, JSON.stringify(held.body));
    assert.equal(held.body.status, 'HELD');
    assert.equal(await openBillOn(table), null, 'no bill opened by a phone nobody has seen');

    const tray = await request('GET', '/api/v1/orders', { token: waiter });
    const notice = tray.body.data.find(o => o.id === held.body.orderId);
    assert.equal(notice.status, 'HELD');
    assert.equal(notice.billId, null);
    assert.equal(notice.items.length, 1);
    assert.equal(notice.items[0].quantity, 2);
    assert.equal(notice.items[0].subtotalMinor, '3000');
    assert.equal(notice.currency, 'VES');
    const summary = await request('GET', '/api/v1/orders/summary', { token: waiter });
    assert.ok(summary.body.awaitingApproval >= 1);

    const mine = await request('GET', `/api/v1/guest/bill/orders/${held.body.orderId}`, ana);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.status, 'HELD');
  });

  it('one held order per phone: a second one waits for the first', async () => {
    const ana = await scan(await newTable());
    assert.equal((await order(ana)).body.status, 'HELD');
    const again = await order(ana);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'GUEST_ORDER_AWAITING_APPROVAL');
  });

  it('approving puts it on the bill (opening one) and that phone then orders without waiting', async () => {
    const table = await newTable();
    const ana = await scan(table);
    const held = await order(ana, null, 2);

    const seenOnly = await request('POST', `/api/v1/orders/${held.body.orderId}/ack`, { token: waiter });
    assert.equal(seenOnly.status, 409, '"seen" does not approve it');
    assert.equal(seenOnly.body.error.code, 'GUEST_ORDER_NEEDS_APPROVAL');

    const approved = await request('POST', `/api/v1/orders/${held.body.orderId}/approve`, { token: waiter });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'PLACED');
    const billId = await openBillOn(table);
    assert.equal(approved.body.billId, billId);
    assert.equal(await linesOn(billId), 1);

    const tray = await request('GET', '/api/v1/orders', { token: waiter });
    assert.ok(!tray.body.data.some(o => o.id === held.body.orderId), 'approved means seen');
    assert.equal((await request('GET', `/api/v1/guest/bill/orders/${held.body.orderId}`, ana)).body.status, 'PLACED');

    const next = await order(ana);
    assert.equal(next.status, 201);
    assert.equal(next.body.status, 'PLACED');
    assert.equal(await linesOn(billId), 2);

    const twice = await request('POST', `/api/v1/orders/${held.body.orderId}/approve`, { token: waiter });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.error.code, 'GUEST_ORDER_ALREADY_DECIDED');
    assert.equal(await linesOn(billId), 2, 'approving twice does not add the lines twice');
  });

  it('approving onto a bill the waiter already opened adds to it', async () => {
    const table = await newTable();
    const bill = await fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0 });
    const ana = await scan(table);
    const held = await order(ana);
    assert.equal(await linesOn(bill.id), 0);
    const approved = await request('POST', `/api/v1/orders/${held.body.orderId}/approve`, { token: waiter });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.billId, bill.id);
    assert.equal(await linesOn(bill.id), 1);
  });

  it('every new phone at the table needs its own approval', async () => {
    const table = await newTable();
    const ana = await scan(table);
    await request('POST', `/api/v1/orders/${(await order(ana)).body.orderId}/approve`, { token: waiter });
    const luis = await scan(table);
    assert.equal((await order(luis)).body.status, 'HELD');
  });

  it('rejecting keeps it off every bill and that phone cannot order again', async () => {
    const table = await newTable();
    const prank = await scan(table);
    const held = await order(prank);
    const rejected = await request('POST', `/api/v1/orders/${held.body.orderId}/reject`, { token: waiter });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.status, 'REJECTED');
    assert.equal(await openBillOn(table), null);
    assert.equal((await request('POST', `/api/v1/orders/${held.body.orderId}/reject`, { token: waiter })).status, 200,
      'rejecting twice is not an error');
    assert.equal((await request('POST', `/api/v1/orders/${held.body.orderId}/approve`, { token: waiter })).status, 409);
    assert.equal((await request('GET', `/api/v1/guest/bill/orders/${held.body.orderId}`, prank)).body.status, 'REJECTED');

    const again = await order(prank);
    assert.equal(again.status, 403);
    assert.equal(again.body.error.code, 'GUEST_ORDERS_BLOCKED');
  });

  it('another phone cannot read someone else\'s order', async () => {
    const table = await newTable();
    const ana = await scan(table);
    const held = await order(ana);
    const luis = await scan(table);
    assert.equal((await request('GET', `/api/v1/guest/bill/orders/${held.body.orderId}`, luis)).status, 404);
  });

  it('a product taken off the menu meanwhile fails the approval and leaves the order held', async () => {
    const table = await newTable();
    const ana = await scan(table);
    const productId = await product();
    const held = await order(ana, productId);
    await db.query('UPDATE menu_products SET active = false WHERE id = $1', [productId]);
    const approved = await request('POST', `/api/v1/orders/${held.body.orderId}/approve`, { token: waiter });
    assert.equal(approved.status, 409, JSON.stringify(approved.body));
    assert.equal(approved.body.error.code, 'PRODUCT_INACTIVE');
    assert.equal(await openBillOn(table), null, 'the failed approval opened nothing');
    assert.equal((await request('GET', `/api/v1/guest/bill/orders/${held.body.orderId}`, ana)).body.status, 'HELD');
  });

  it('two staff approving at once add the lines once', async () => {
    const table = await newTable();
    const held = await order(await scan(table));
    const results = await Promise.all([1, 2, 3].map(() =>
      request('POST', `/api/v1/orders/${held.body.orderId}/approve`, { token: waiter })));
    assert.equal(results.filter(r => r.status === 200).length, 1);
    assert.ok(results.filter(r => r.status !== 200).every(r => r.status === 409));
    assert.equal(await linesOn(await openBillOn(table)), 1);
  });
});
