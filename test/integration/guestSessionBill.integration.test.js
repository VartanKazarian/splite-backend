const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload } = require('../../src/utils/tokens');
const config = require('../../src/config');

/**
 * Una sesión de comensal es de una cuenta, no de la mesa.
 *
 * Antes, quien se iba con la sesión abierta en el teléfono veía -- y podía
 * pedir sobre -- la cuenta de los siguientes en sentarse, durante las dos horas
 * de inactividad que dura una sesión.
 */
describe('a guest session belongs to one bill, not to the table', { skip }, () => {
  let server;
  let base;
  let restaurant;
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

  const newTable = async () => {
    const created = await fixtures.createTable(restaurant.id, { name: `SB${++seq}` });
    return (await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id])).rows[0];
  };
  const openBill = (table, total = 10000) => fixtures.createBill({
    restaurantId: restaurant.id, tableId: table.id, totalDue: total, totalDueVes: total
  });
  const closeBill = (bill, status = 'CLOSED') => db.query(
    `UPDATE bills SET status = $2::text,
            amount_paid_ves = CASE WHEN $2::text = 'CLOSED' THEN total_due_ves ELSE 0 END
      WHERE id = $1`, [bill.id, status]);

  const scan = async (table) => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: table.restaurant_id, nonce: table.qr_nonce,
      iat: now, ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const res = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { session: res.body.sessionId, token: res.body.guestToken };
  };
  const boundTo = async (diner) => (await db.query(
    'SELECT bill_id FROM guest_sessions WHERE id = $1', [diner.session])).rows[0].bill_id;

  const viewBill = (diner) => request('GET', '/api/v1/guest/bill', diner);
  const declare = (diner, amountVes) => request('POST', '/api/v1/guest/bill/payment-claims', {
    ...diner, body: { amountVes, reference: String(Date.now() + ++seq).slice(-10) }
  });
  const product = async () => (await db.query(
    `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
     VALUES ($1, $2, 1500, 'VES', true) RETURNING id`, [restaurant.id, `P${++seq}`])).rows[0].id;
  const order = async (diner) => request('POST', '/api/v1/guest/bill/orders', {
    ...diner, body: { items: [{ productId: await product(), quantity: 1 }] }
  });

  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:rl:*'),
      ...await redis.keys('guest:order:*'), ...await redis.keys('guest:qrctx:*')
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    await clearRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Session Bill Tenant' });
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
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('scanning a table with an open bill ties the session to that bill', async () => {
    const table = await newTable();
    const bill = await openBill(table);
    const ana = await scan(table);
    assert.equal(await boundTo(ana), bill.id);
    const res = await viewBill(ana);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, bill.id);
  });

  it('after the bill closes, the old session cannot see or order on the next party\'s bill', async () => {
    const table = await newTable();
    const first = await openBill(table);
    const leaver = await scan(table);
    await closeBill(first);
    const next = await openBill(table, 25000);

    const seen = await viewBill(leaver);
    assert.equal(seen.status, 404);
    assert.equal(seen.body.error.code, 'OPEN_BILL_NOT_FOUND');
    assert.equal(seen.body.error.details.reason, 'SESSION_BILL_ENDED');

    const ordered = await order(leaver);
    assert.equal(ordered.status, 404, JSON.stringify(ordered.body));
    assert.equal(ordered.body.error.details.reason, 'SESSION_BILL_ENDED');
    const lines = (await db.query('SELECT COUNT(*)::int AS n FROM bill_items WHERE bill_id = $1', [next.id])).rows[0].n;
    assert.equal(lines, 0, 'nothing reached the next party\'s bill');

    const declared = await declare(leaver, '1000');
    assert.equal(declared.status, 404);

    // Scanning again is a new session, for the bill at the table now.
    const fresh = await scan(table);
    const now = await viewBill(fresh);
    assert.equal(now.status, 200);
    assert.equal(now.body.id, next.id);
  });

  it('a voided bill ends the session the same way', async () => {
    const table = await newTable();
    const first = await openBill(table);
    const ana = await scan(table);
    await closeBill(first, 'VOID');
    await openBill(table);
    const res = await viewBill(ana);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.details.reason, 'SESSION_BILL_ENDED');
  });

  it('the diner\'s own receipts stay reachable after the bill closes; the next bill\'s do not', async () => {
    const table = await newTable();
    const first = await openBill(table);
    const ana = await scan(table);
    const mine = await declare(ana, '10000');
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    await closeBill(first);

    const second = await openBill(table);
    const luis = await scan(table);
    const theirs = await declare(luis, '5000');
    assert.equal(theirs.status, 201);

    assert.equal((await request('GET', `/api/v1/guest/payments/${mine.body.id}`, ana)).status, 200);
    assert.equal((await request('GET', `/api/v1/guest/payments/${theirs.body.id}`, ana)).status, 404);
    assert.equal((await request('GET', `/api/v1/guest/payments/${mine.body.id}`, luis)).status, 404);
    assert.equal(second.status, 'OPEN');
  });

  it('a session from an empty table attaches to a bill opened soon after', async () => {
    const table = await newTable();
    const ana = await scan(table);
    assert.equal(await boundTo(ana), null);
    const empty = await viewBill(ana);
    assert.equal(empty.status, 404);
    assert.equal(empty.body.error.details.reason, 'NO_OPEN_BILL');

    const bill = await openBill(table);
    const res = await viewBill(ana);
    assert.equal(res.status, 200);
    assert.equal(res.body.id, bill.id);
    assert.equal(await boundTo(ana), bill.id);
  });

  it('…but not to one opened long after: that is someone else\'s', async () => {
    const table = await newTable();
    const leaver = await scan(table);
    await db.query(
      `UPDATE guest_sessions SET created_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
      [leaver.session, config.guest.billBindWindowSeconds + 60]);
    await openBill(table);

    const res = await viewBill(leaver);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.details.reason, 'SESSION_PREDATES_BILL');
    assert.equal(await boundTo(leaver), null);
    assert.equal((await order(leaver)).status, 404);
  });

  it('a diner whose order opens the bill is tied to it', async () => {
    const table = await newTable();
    const ana = await scan(table);
    const placed = await order(ana);
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    const open = (await db.query(
      "SELECT id FROM bills WHERE table_id = $1 AND status = 'OPEN'", [table.id])).rows[0];
    assert.equal(await boundTo(ana), open.id);
  });

  it('simultaneous first requests from one session bind it once', async () => {
    const table = await newTable();
    const ana = await scan(table);
    const bill = await openBill(table);
    const results = await Promise.all(Array.from({ length: 6 }, () => viewBill(ana)));
    assert.ok(results.every(r => r.status === 200 && r.body.id === bill.id));
    assert.equal(await boundTo(ana), bill.id);
  });
});
