const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload } = require('../../src/utils/tokens');
const config = require('../../src/config');
const paymentClaims = require('../../src/services/paymentClaims');

/**
 * Lo que el teléfono sabe de un pago que declaró.
 *
 * El comensal que avisó de una transferencia tiene que enterarse de si el
 * personal la confirmó o la rechazó, y cuándo, sin preguntar al mesero. El
 * motivo del rechazo es una nota interna y no viaja.
 */
describe('a diner follows the payment they declared', { skip }, () => {
  let server;
  let base;
  let restaurant;
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

  const dinerAtNewTable = async () => {
    const created = await fixtures.createTable(restaurant.id, { name: `PS${++seq}` });
    const table = (await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id])).rows[0];
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 50000, totalDueVes: 50000 });
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
  const declare = (diner, reference = String(Date.now() + ++seq).slice(-10)) =>
    request('POST', '/api/v1/guest/bill/payment-claims', { ...diner, body: { amountVes: '10000', reference } });
  const statusOf = (diner, id) => request('GET', `/api/v1/guest/payments/${id}`, diner);

  const clearRateLimits = async () => {
    const keys = [...await redis.keys('guest:mint:*'), ...mySessions.map(id => `guest:rl:${id}`)];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Payment Status Tenant' });
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

  it('while nobody has checked it, it is pending with no decision time', async () => {
    const ana = await dinerAtNewTable();
    const claim = await declare(ana);
    assert.equal(claim.status, 201, JSON.stringify(claim.body));
    const status = await statusOf(ana, claim.body.id);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'PENDING');
    assert.equal(status.body.decidedAt, null);
  });

  it('once the staff confirm it, it says so and when', async () => {
    const ana = await dinerAtNewTable();
    const claim = await declare(ana);
    const askedAt = Date.now();
    await paymentClaims.confirmClaim({ restaurantId: restaurant.id, claimId: claim.body.id, actor: null });
    const status = await statusOf(ana, claim.body.id);
    assert.equal(status.body.status, 'SUCCEEDED');
    assert.ok(Date.parse(status.body.decidedAt) >= askedAt - 2000, status.body.decidedAt);
  });

  it('once the staff reject it, it says so and when, without the internal reason', async () => {
    const ana = await dinerAtNewTable();
    const reference = String(Date.now() + ++seq).slice(-10);
    const claim = await declare(ana, reference);
    await paymentClaims.rejectClaim({
      restaurantId: restaurant.id, claimId: claim.body.id, reason: 'nota interna: no aparece en Mercantil', actor: null
    });
    const status = await statusOf(ana, claim.body.id);
    assert.equal(status.body.status, 'FAILED');
    assert.ok(status.body.decidedAt);
    assert.ok(!JSON.stringify(status.body).includes('nota interna'), 'the staff note stays internal');

    // A diner who mistyped the reference can declare again with the same one.
    const again = await declare(ana, reference);
    assert.equal(again.status, 201, JSON.stringify(again.body));
  });
});
