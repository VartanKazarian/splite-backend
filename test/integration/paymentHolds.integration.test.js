const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload } = require('../../src/utils/tokens');
const config = require('../../src/config');
const splits = require('../../src/services/splits');

/**
 * «Ana está pagando 100 Bs.»
 *
 * Un Pago Móvil no pasa por Splite: cuando la cuenta se cierra, la segunda
 * transferencia ya está hecha. Lo que evita que dos comensales paguen lo mismo
 * es que el segundo vea, antes de ir a su banco, que eso ya lo está pagando
 * alguien, y no pueda empezar a pagarlo. Pero nunca se le rechaza un aviso a
 * quien ya transfirió.
 */
describe('payment holds stop a second diner before they transfer', { skip }, () => {
  let server;
  let base;
  let restaurant;
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
    const created = await fixtures.createTable(restaurant.id, { name: `H${++seq}` });
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
    return { session: res.body.sessionId, token: res.body.guestToken };
  };

  const hold = (diner, amountVes, extra = {}) =>
    request('POST', '/api/v1/guest/bill/holds', { ...diner, body: { amountVes, ...extra } });
  const release = (diner) => request('DELETE', '/api/v1/guest/bill/holds', diner);
  const view = (diner) => request('GET', '/api/v1/guest/bill', diner);
  const declare = (diner, amountVes, extra = {}) => request('POST', '/api/v1/guest/bill/payment-claims', {
    ...diner, body: { amountVes, reference: String(Date.now() + ++seq).slice(-10), ...extra }
  });
  const liveHolds = async (billId) => (await db.query(
    `SELECT amount_ves, guest_session_id FROM payment_holds
      WHERE bill_id = $1 AND released_at IS NULL AND consumed_by_payment_id IS NULL AND expires_at > NOW()`,
    [billId])).rows;

  // These tests open many guest sessions, and the session limiter
  // (guest:mint, 60 a minute per IP) is shared with every other file in the
  // run: cleared before each test and after the file, so neither this file nor
  // the next one inherits a full bucket.
  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:rl:*'), ...await redis.keys('guest:qrctx:*')
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    await clearRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Holds Tenant' });
    staffUserId = (await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
      [restaurant.id, `holds-${restaurant.id}@example.com`]
    )).rows[0].id;
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
      await db.query('DELETE FROM payment_holds WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('two diners pressing «Pagar» at once: exactly one gets the balance', async () => {
    const { table, bill } = await tableAndBill(10000);
    const [ana, luis] = await Promise.all([scan(table), scan(table)]);

    const results = await Promise.all([hold(ana, '10000'), hold(luis, '10000')]);
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [201, 409], JSON.stringify(results.map(r => r.body)));

    const refused = results.find(r => r.status === 409).body.error;
    assert.equal(refused.code, 'PAYMENT_HELD');
    assert.equal(refused.details.availableVes, '0');
    assert.equal(refused.details.heldVes, '10000');
    assert.ok(Date.parse(refused.details.heldUntil) > Date.now());
    assert.equal((await liveHolds(bill.id)).length, 1);
  });

  it('the second diner can still pay what is not being paid', async () => {
    const { table } = await tableAndBill(10000);
    const [ana, luis] = [await scan(table), await scan(table)];

    assert.equal((await hold(ana, '4000')).status, 201);
    const tooMuch = await hold(luis, '7000');
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.body.error.details.availableVes, '6000');
    assert.equal((await hold(luis, '6000')).status, 201);
  });

  it('each diner sees the others\' reservations, not their own', async () => {
    const { table } = await tableAndBill(10000);
    const [ana, luis] = [await scan(table), await scan(table)];
    const placed = await hold(ana, '4000');

    const forLuis = (await view(luis)).body;
    assert.equal(forLuis.heldVes, '4000');
    assert.equal(forLuis.availableVes, '6000');
    assert.equal(forLuis.myHold, null);
    assert.equal(forLuis.remainingVes, '10000', 'a reservation moves no money');

    const forAna = (await view(ana)).body;
    assert.equal(forAna.heldVes, '0');
    assert.equal(forAna.availableVes, '10000');
    assert.equal(forAna.myHold.id, placed.body.id);
    assert.equal(forAna.myHold.amountVes, '4000');
  });

  it('going back frees the balance for the table', async () => {
    const { table } = await tableAndBill(10000);
    const [ana, luis] = [await scan(table), await scan(table)];
    await hold(ana, '10000');
    assert.equal((await hold(luis, '10000')).status, 409);

    assert.equal((await release(ana)).status, 204);
    assert.equal((await release(ana)).status, 204, 'idempotent');
    assert.equal((await hold(luis, '10000')).status, 201);
  });

  it('a reservation nobody comes back to lapses by itself', async () => {
    const { table, bill } = await tableAndBill(10000);
    const [ana, luis] = [await scan(table), await scan(table)];
    await hold(ana, '10000');
    await db.query(
      "UPDATE payment_holds SET expires_at = NOW() - INTERVAL '1 second' WHERE bill_id = $1", [bill.id]);

    assert.equal((await view(luis)).body.heldVes, '0');
    assert.equal((await hold(luis, '10000')).status, 201);
    // And the diner whose reservation lapsed now finds the balance taken.
    assert.equal((await hold(ana, '1')).status, 409);
  });

  it('pressing «Pagar» again changes the reservation instead of stacking another', async () => {
    const { table, bill } = await tableAndBill(10000);
    const ana = await scan(table);
    await hold(ana, '4000');
    await hold(ana, '3000');
    const live = await liveHolds(bill.id);
    assert.equal(live.length, 1);
    assert.equal(live[0].amount_ves, '3000');

    // Also after it lapsed: the lapsed row is reused, not left to block.
    await db.query(
      "UPDATE payment_holds SET expires_at = NOW() - INTERVAL '1 second' WHERE bill_id = $1", [bill.id]);
    assert.equal((await hold(ana, '5000')).status, 201);
    assert.equal((await liveHolds(bill.id))[0].amount_ves, '5000');
  });

  it('declaring turns the reservation into a pending payment, counted once', async () => {
    const { table, bill } = await tableAndBill(10000);
    const [ana, luis] = [await scan(table), await scan(table)];
    await hold(ana, '4000');
    const claim = await declare(ana, '4000');
    assert.equal(claim.status, 201, JSON.stringify(claim.body));

    assert.equal((await liveHolds(bill.id)).length, 0);
    const consumed = (await db.query(
      'SELECT consumed_by_payment_id FROM payment_holds WHERE bill_id = $1', [bill.id])).rows[0];
    assert.equal(consumed.consumed_by_payment_id, claim.body.id);

    const forLuis = (await view(luis)).body;
    assert.equal(forLuis.pendingVes, '4000');
    assert.equal(forLuis.heldVes, '0');
    assert.equal(forLuis.availableVes, '6000');
  });

  it('a diner who already transferred can always declare, reservation or not', async () => {
    const { table } = await tableAndBill(10000);
    const [ana, luis] = [await scan(table), await scan(table)];
    await hold(ana, '10000');
    const late = await declare(luis, '10000');
    assert.equal(late.status, 201, 'money already sent is recorded, never refused');
    assert.equal(late.body.status, 'PENDING');
  });

  it('a split share being paid by one diner cannot be reserved by another', async () => {
    const { table, bill } = await tableAndBill(10000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] },
      createdBy: { type: 'STAFF', id: staffUserId }
    });
    const shareA = split.participants.find(p => p.ext_ref === 'a');
    const shareB = split.participants.find(p => p.ext_ref === 'b');
    const [ana, luis] = [await scan(table), await scan(table)];

    assert.equal((await hold(ana, shareA.amount_ves, { splitParticipantId: shareA.id })).status, 201);
    const taken = await hold(luis, shareA.amount_ves, { splitParticipantId: shareA.id });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'PAYMENT_HELD');
    assert.equal(taken.body.error.details.availableVes, '0');
    assert.equal((await hold(luis, shareB.amount_ves, { splitParticipantId: shareB.id })).status, 201);

    const shares = (await request('GET', '/api/v1/guest/bill/splits/active', luis)).body.participants;
    const a = shares.find(p => p.ref === 'a');
    const b = shares.find(p => p.ref === 'b');
    assert.equal(a.heldVes, '5000');
    assert.equal(a.availableVes, '0');
    assert.equal(b.heldVes, '0', 'Luis\'s own reservation is his, not someone else\'s');
  });

  it('refuses a reservation larger than the bill, or on a closed bill', async () => {
    const { table, bill } = await tableAndBill(10000);
    const ana = await scan(table);
    const over = await hold(ana, '10001');
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'PAYMENT_EXCEEDS_BALANCE');

    assert.equal((await hold(ana, '0')).status, 400);

    await db.query("UPDATE bills SET status = 'CLOSED', amount_paid_ves = total_due_ves WHERE id = $1", [bill.id]);
    const closed = await hold(ana, '1');
    assert.ok([404, 409].includes(closed.status), JSON.stringify(closed.body));
  });
});
