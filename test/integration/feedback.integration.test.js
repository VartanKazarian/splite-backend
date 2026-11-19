const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken, signReceiptLink } = require('../../src/utils/tokens');
const config = require('../../src/config');
const claims = require('../../src/services/paymentClaims');

/**
 * Después de pagar (R20): la opinión del comensal, el enlace a Google y el
 * recibo que se manda por WhatsApp.
 */
describe('after paying: rating, Google link and a shareable receipt', { skip }, () => {
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

  /** Una mesa con su cuenta, un comensal que escaneó, y un aviso de pago suyo. */
  const dinerWhoPaid = async () => {
    const created = await fixtures.createTable(restaurant.id, { name: `F${++seq}` });
    const table = (await db.query(
      'SELECT id, restaurant_id, qr_nonce, name FROM tables WHERE id = $1', [created.id])).rows[0];
    const bill = await fixtures.createBill({
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
    const claim = await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '2000000',
      reference: `55${String(Date.now() + seq).slice(-8)}`
    });
    return {
      table, bill, claim,
      diner: { session: scanned.body.sessionId, token: scanned.body.guestToken }
    };
  };

  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:qrctx:*'),
      ...await redis.keys('receipt-link*'), ...mySessions.map(id => `guest:rl:${id}`)
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Feedback Tenant' });
    const ids = {};
    for (const role of ['OWNER', 'WAITER']) {
      ids[role] = (await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [restaurant.id, `fb-${role.toLowerCase()}-${restaurant.id}@example.com`, role])).rows[0].id;
    }
    owner = signAccessToken({ id: ids.OWNER, restaurantId: restaurant.id, role: 'OWNER' });
    waiter = signAccessToken({ id: ids.WAITER, restaurantId: restaurant.id, role: 'WAITER' });
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
      await db.query('DELETE FROM diner_feedback WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payment_holds WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('a diner rates once per bill, and rating again corrects it', async () => {
    const { claim, diner, table } = await dinerWhoPaid();
    const first = await request('POST', `/api/v1/guest/payments/${claim.id}/feedback`, {
      ...diner, body: { rating: 2, comment: '  La comida tardó  ' }
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, { googleReviewUrl: null });

    await request('POST', `/api/v1/guest/payments/${claim.id}/feedback`, { ...diner, body: { rating: 4 } });
    const { rows } = await db.query(
      'SELECT rating, comment, table_name FROM diner_feedback WHERE payment_id = $1', [claim.id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rating, 4);
    assert.equal(rows[0].comment, null);
    assert.equal(rows[0].table_name, table.name);
  });

  it('the Google link goes to every diner who rates, one star or five', async () => {
    const bad = await request('PATCH', '/api/v1/account', {
      token: owner, body: { googleReviewUrl: 'https://evil.example.com/review' }
    });
    assert.equal(bad.status, 400);
    const set = await request('PATCH', '/api/v1/account', {
      token: owner, body: { googleReviewUrl: 'https://g.page/r/CasaFeedback/review' }
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.googleReviewUrl, 'https://g.page/r/CasaFeedback/review');

    for (const rating of [1, 5]) {
      const { claim, diner } = await dinerWhoPaid();
      const res = await request('POST', `/api/v1/guest/payments/${claim.id}/feedback`, { ...diner, body: { rating } });
      assert.equal(res.body.googleReviewUrl, 'https://g.page/r/CasaFeedback/review', `rating ${rating}`);
    }

    const cleared = await request('PATCH', '/api/v1/account', { token: owner, body: { googleReviewUrl: '' } });
    assert.equal(cleared.body.googleReviewUrl, null);
  });

  it('a rejected payment cannot be rated, and another table\'s payment does not exist', async () => {
    const { claim, diner } = await dinerWhoPaid();
    await claims.rejectClaim({ restaurantId: restaurant.id, claimId: claim.id, actor: { id: null } });
    const rejected = await request('POST', `/api/v1/guest/payments/${claim.id}/feedback`, { ...diner, body: { rating: 5 } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, 'PAYMENT_NOT_RATEABLE');

    const other = await dinerWhoPaid();
    const elsewhere = await request('POST', `/api/v1/guest/payments/${other.claim.id}/feedback`, {
      ...diner, body: { rating: 5 }
    });
    assert.equal(elsewhere.status, 404);
  });

  it('the panel shows owners the average and the latest, and waiters nothing', async () => {
    const res = await request('GET', '/api/v1/feedback?days=30', { token: owner });
    assert.equal(res.status, 200);
    const total = Object.values(res.body.distribution).reduce((a, b) => a + b, 0);
    assert.equal(res.body.count, total);
    assert.ok(res.body.count >= 3);
    assert.ok(res.body.average >= 1 && res.body.average <= 5);
    assert.ok(res.body.recent.every(r => r.tableName && r.createdAt && !('guestSessionId' in r)));

    assert.equal((await request('GET', '/api/v1/feedback', { token: waiter })).status, 403);
  });

  it('a shared receipt link opens without a session, with the reference cut to four digits', async () => {
    const { claim, diner } = await dinerWhoPaid();
    const link = await request('POST', `/api/v1/guest/payments/${claim.id}/receipt-link`, diner);
    assert.equal(link.status, 200, JSON.stringify(link.body));
    assert.ok(new Date(link.body.expiresAt) > new Date(Date.now() + 170 * 24 * 3600 * 1000));

    const opened = await request('GET', `/api/v1/receipts/${link.body.token}`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.payment.amountVes, '2000000');
    assert.match(opened.body.payment.reference, /^…\d{4}$/);
    assert.equal(opened.body.restaurant.name, 'Feedback Tenant');

    const [body] = link.body.token.split('.');
    for (const token of [`${body}.forged`, `${body}x.${link.body.token.split('.')[1]}`]) {
      assert.equal((await request('GET', `/api/v1/receipts/${token}`)).status, 404, token);
    }
    const expired = signReceiptLink({ paymentId: claim.id, restaurantId: restaurant.id, ttlSeconds: -10 });
    assert.equal((await request('GET', `/api/v1/receipts/${expired.token}`)).status, 404);
  });
});
