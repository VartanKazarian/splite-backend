const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const config = require('../../src/config');
const claims = require('../../src/services/paymentClaims');
const splits = require('../../src/services/splits');
const dto = require('../../src/dto');

/**
 * Two diners, one balance.
 *
 * A Pago Móvil claim is declared after the diner's bank has sent the money, so
 * Splite cannot stop the second transfer by refusing its declaration -- that
 * would only lose track of it. What it must do is (1) show everyone at the
 * table what is already being verified, before they transfer, (2) tell the
 * person verifying when two claims cover the same balance, and (3) refuse to
 * void a bill that someone has, as far as anyone knows, already paid.
 */
describe('pending payments are visible and protected', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let staffToken;
  let staffUserId;
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

  const tableAndBill = async (total = 10000) => {
    const created = await fixtures.createTable(restaurant.id, { name: `PP${++seq}` });
    const table = (await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id])).rows[0];
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: total, totalDueVes: total
    });
    return { table, bill };
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

  const declare = (bill, amountVes, extra = {}) => claims.declareClaim({
    restaurantId: restaurant.id, billId: bill.id, amountVes,
    reference: String(Date.now() + ++seq).slice(-10),
    payer: { type: 'GUEST', id: null }, ...extra
  });

  // Includes the guest limiters (session minting is 60 a minute per IP, shared
  // by every file in the run), before each test and after the file.
  const mySessions = [];
  const clearIpRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:qrctx:*'),
      // Only the per-session buckets of sessions this file opened: other files
      // run in parallel and fill their own on purpose (guestRateLimit).
      ...mySessions.map(id => `guest:rl:${id}`)
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Pending Tenant' });
    staffUserId = (await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
      [restaurant.id, `pending-${restaurant.id}@example.com`]
    )).rows[0].id;
    staffToken = signAccessToken({ id: staffUserId, restaurantId: restaurant.id, role: 'OWNER' });
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(clearIpRateLimits);

  after(async () => {
    await clearIpRateLimits();
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('two simultaneous declarations of the whole balance are both recorded, and the overlap is flagged', async () => {
    const { bill } = await tableAndBill(10000);

    // Both transfers have already left the diners' banks; both must be kept.
    const [a, b] = await Promise.all([declare(bill, '10000'), declare(bill, '10000')]);
    assert.equal(a.status, 'PENDING');
    assert.equal(b.status, 'PENDING');

    // Serialised on the bill lock, so exactly one of them saw the other.
    const rows = (await db.query(
      'SELECT * FROM payments WHERE id = ANY($1::uuid[]) AND restaurant_id = $2',
      [[a.id, b.id], restaurant.id]
    )).rows.map(dto.staffPaymentClaim);
    assert.deepEqual(rows.map(r => r.overlapsPending).sort(), [false, true]);

    // And the diner-facing view of a claim does not carry the flag.
    assert.equal(dto.paymentClaim((await db.query(
      'SELECT * FROM payments WHERE id = $1', [a.id])).rows[0]).overlapsPending, undefined);
  });

  it('a declaration within what is left is not flagged', async () => {
    const { bill } = await tableAndBill(10000);
    const first = await declare(bill, '4000');
    const second = await declare(bill, '6000');
    const flags = (await db.query(
      'SELECT id, metadata FROM payments WHERE id = ANY($1::uuid[])', [[first.id, second.id]]
    )).rows.map(r => r.metadata.overlapsPending);
    assert.deepEqual(flags, [false, false]);
  });

  it('the guest bill shows what is being verified and what is left to transfer', async () => {
    const { table, bill } = await tableAndBill(10000);
    const session = await scan(table);

    const initial = await request('GET', '/api/v1/guest/bill', session);
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.pendingVes, '0');
    assert.equal(initial.body.pendingCount, 0);
    assert.equal(initial.body.availableVes, '10000');

    await declare(bill, '4000');
    const during = await request('GET', '/api/v1/guest/bill', session);
    assert.equal(during.body.remainingVes, '10000', 'the ledger is untouched until staff confirm');
    assert.equal(during.body.pendingVes, '4000');
    assert.equal(during.body.pendingCount, 1);
    assert.equal(during.body.availableVes, '6000');

    // Over-declared: available bottoms out at zero, never negative.
    await declare(bill, '10000');
    const over = await request('GET', '/api/v1/guest/bill', session);
    assert.equal(over.body.pendingVes, '14000');
    assert.equal(over.body.availableVes, '0');
  });

  it('a rejected claim stops counting as pending', async () => {
    const { table, bill } = await tableAndBill(10000);
    const session = await scan(table);
    const claim = await declare(bill, '4000');
    await claims.rejectClaim({ restaurantId: restaurant.id, claimId: claim.id, actor: { id: staffUserId } });

    const res = await request('GET', '/api/v1/guest/bill', session);
    assert.equal(res.body.pendingVes, '0');
    assert.equal(res.body.availableVes, '10000');
  });

  it('each split share shows what has been declared against it', async () => {
    const { bill } = await tableAndBill(10000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] },
      createdBy: { type: 'STAFF', id: staffUserId }
    });
    const [shareA] = split.participants;
    await declare(bill, shareA.amount_ves, { splitParticipantId: shareA.id });

    const view = dto.billSplit(await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id }));
    const a = view.participants.find(p => p.ref === 'a');
    const b = view.participants.find(p => p.ref === 'b');
    assert.equal(a.pendingVes, '5000');
    assert.equal(a.availableVes, '0');
    assert.equal(a.settled, false, 'declared is not settled');
    assert.equal(b.pendingVes, '0');
    assert.equal(b.availableVes, '5000');
  });

  it('a bill with a payment still being verified cannot be voided', async () => {
    const { bill } = await tableAndBill(10000);
    const claim = await declare(bill, '4000');

    const refused = await request('POST', `/api/v1/bills/${bill.id}/void`, { token: staffToken });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'BILL_HAS_PAYMENTS');
    assert.equal(refused.body.error.details.inFlightPayments, 1);
    assert.equal((await fixtures.readBill(bill.id)).status, 'OPEN');

    // Once the claim is resolved the bill can be voided as before.
    await claims.rejectClaim({ restaurantId: restaurant.id, claimId: claim.id, actor: { id: staffUserId } });
    const voided = await request('POST', `/api/v1/bills/${bill.id}/void`, { token: staffToken });
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.status, 'VOID');
  });

  it('void keeps its existing refusals', async () => {
    const { bill } = await tableAndBill(10000);
    await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [bill.id]);
    const closed = await request('POST', `/api/v1/bills/${bill.id}/void`, { token: staffToken });
    assert.equal(closed.status, 409);
    assert.equal(closed.body.error.code, 'BILL_NOT_OPEN');

    const missing = await request('POST', '/api/v1/bills/00000000-0000-4000-8000-000000000001/void', { token: staffToken });
    assert.equal(missing.status, 404);
  });
});
