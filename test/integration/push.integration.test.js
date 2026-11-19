const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const config = require('../../src/config');
const push = require('../../src/services/push');
const claims = require('../../src/services/paymentClaims');
const { revokeAllSessionsForUser } = require('../../src/services/auth');

/**
 * Avisos en el teléfono del personal (R19).
 *
 * El servicio de push de verdad no se toca: `push.setSender` pone en su sitio
 * un buzón que apunta qué se mandó y a quién, y que puede contestar como
 * contestaría Google -- con un 410 para una suscripción que ya no existe.
 */
describe('push notifications to staff', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let seq = 0;
  const staff = {};
  const mySessions = [];
  let outbox = [];
  let restoreSender;
  let answer = () => undefined;

  const P256DH = 'B' + 'A'.repeat(86);
  const AUTH = 'C'.repeat(22);
  const endpointFor = name => `https://fcm.googleapis.com/fcm/send/${name}-${restaurant.id}`;

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

  const subscribe = (who, name = who) => request('POST', '/api/v1/push/subscriptions', {
    token: staff[who].token,
    body: { endpoint: endpointFor(name), expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } }
  });

  /** A quién le llegó algo, por nombre del teléfono. */
  const delivered = () => outbox.map(m => m.endpoint.split('/').pop().replace(`-${restaurant.id}`, '')).sort();

  const clearRateLimits = async () => {
    const keys = [
      ...await redis.keys('guest:mint:*'), ...await redis.keys('guest:order:*'),
      ...await redis.keys('guest:qrctx:*'), ...await redis.keys('push*'),
      ...mySessions.map(id => `guest:rl:${id}`)
    ];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1', ...keys);
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Push Tenant' });
    for (const role of ['OWNER', 'CASHIER', 'WAITER']) {
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [restaurant.id, `push-${role.toLowerCase()}-${restaurant.id}@example.com`, role]);
      staff[role.toLowerCase()] = {
        id: rows[0].id,
        token: signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role })
      };
    }
    restoreSender = push.setSender(async (subscription, payload, options) => {
      outbox.push({ endpoint: subscription.endpoint, message: JSON.parse(payload), options });
      const error = answer(subscription);
      if (error) throw error;
    });
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    await clearRateLimits();
    await db.query('DELETE FROM push_subscriptions WHERE restaurant_id = $1', [restaurant.id]);
    outbox = [];
    answer = () => undefined;
  });

  after(async () => {
    restoreSender?.();
    await clearRateLimits();
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM push_subscriptions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM guest_orders WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payment_holds WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('hands out one public key, the same every time', async () => {
    const first = await request('GET', '/api/v1/push/config', { token: staff.waiter.token });
    assert.equal(first.status, 200);
    assert.equal(first.body.enabled, true);
    assert.match(first.body.publicKey, /^[A-Za-z0-9_-]{80,}$/);
    const again = await request('GET', '/api/v1/push/config', { token: staff.owner.token });
    assert.equal(again.body.publicKey, first.body.publicKey);
  });

  it('only subscribes real push services: anything else would be the server POSTing wherever it is told', async () => {
    for (const endpoint of [
      'https://evil.example.com/collect',
      'https://fcm.googleapis.com.evil.example.com/x',
      'https://169.254.169.254/latest',
      'http://fcm.googleapis.com/fcm/send/x',
      'https://fcm.googleapis.com:8443/fcm/send/x'
    ]) {
      const res = await request('POST', '/api/v1/push/subscriptions', {
        token: staff.cashier.token, body: { endpoint, keys: { p256dh: P256DH, auth: AUTH } }
      });
      assert.equal(res.status, 400, endpoint);
    }
    assert.equal((await subscribe('cashier')).status, 204);
  });

  it('a payment notice reaches whoever verifies payments, and nobody else', async () => {
    await subscribe('owner');
    await subscribe('cashier');
    await subscribe('waiter');
    const table = await fixtures.createTable(restaurant.id, { name: `P${++seq}` });
    const bill = await fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 4500000, totalDueVes: 4500000 });

    await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '4500000', reference: `98${String(Date.now()).slice(-8)}`
    });
    await push.settled();

    assert.deepEqual(delivered(), ['cashier', 'owner']);
    const { message, options } = outbox[0];
    assert.equal(message.title, `Pago por verificar · Mesa ${table.name}`);
    assert.equal(message.body, '45.000,00 Bs por Pago Móvil. Compruébalo en el banco.');
    assert.equal(message.url, '/pagos');
    assert.equal(options.urgency, 'high');
    // Nothing a lock screen should show: no reference, no phone, no name.
    assert.doesNotMatch(JSON.stringify(message), /98\d{6}/);
  });

  it('an order from the table reaches the floor, and a held one says it needs approving', async () => {
    await subscribe('cashier');
    await subscribe('waiter');
    const table = (await db.query('SELECT id, restaurant_id, qr_nonce, name FROM tables WHERE id = $1', [
      (await fixtures.createTable(restaurant.id, { name: `O${++seq}` })).id])).rows[0];
    const now = Math.floor(Date.now() / 1000);
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: table.restaurant_id, nonce: table.qr_nonce, iat: now,
      ...(config.qrTtlSeconds > 0 ? { exp: now + config.qrTtlSeconds } : {})
    });
    const scanned = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(scanned.status, 201);
    mySessions.push(scanned.body.sessionId);
    const diner = { session: scanned.body.sessionId, token: scanned.body.guestToken };
    const product = (await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
       VALUES ($1, 'Tequeños', 800, 'VES', true) RETURNING id`, [restaurant.id])).rows[0].id;

    await db.query('UPDATE restaurants SET approve_new_phone_orders = true WHERE id = $1', [restaurant.id]);
    try {
      const held = await request('POST', '/api/v1/guest/bill/orders', {
        ...diner, body: { items: [{ productId: product, quantity: 2 }] }
      });
      assert.equal(held.body.status, 'HELD');
      await push.settled();
      assert.deepEqual(delivered(), ['waiter']);
      assert.equal(outbox[0].message.title, `Pedido por aprobar · Mesa ${table.name}`);
      assert.equal(outbox[0].message.body, 'Primer pedido de un teléfono nuevo: 2 × Tequeños.');
    } finally {
      await db.query('UPDATE restaurants SET approve_new_phone_orders = false WHERE id = $1', [restaurant.id]);
      await db.query(`DELETE FROM guest_orders WHERE restaurant_id = $1 AND status = 'HELD'`, [restaurant.id]);
    }

    outbox = [];
    const placed = await request('POST', '/api/v1/guest/bill/orders', {
      ...diner, body: { items: [{ productId: product, quantity: 1 }] }
    });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    await push.settled();
    assert.deepEqual(delivered(), ['waiter']);
    assert.equal(outbox[0].message.title, `Pedido nuevo · Mesa ${table.name}`);
    assert.equal(outbox[0].message.body, 'Tequeños.');
  });

  it('a phone the push service says is gone is forgotten; one that merely failed is kept', async () => {
    await subscribe('owner', 'gone');
    await subscribe('cashier', 'flaky');
    answer = sub => {
      if (sub.endpoint.includes('gone')) return Object.assign(new Error('Gone'), { statusCode: 410 });
      return Object.assign(new Error('Bad gateway'), { statusCode: 502 });
    };
    const result = await push.deliver({
      restaurantId: restaurant.id, roles: push.AUDIENCE.claim, ttlSeconds: 60,
      message: { title: 't', body: 'b', url: '/pagos', tag: 'x' }
    });
    assert.deepEqual(result, { sent: 0, gone: 1, failed: 1 });
    const { rows } = await db.query(
      'SELECT endpoint, failures FROM push_subscriptions WHERE restaurant_id = $1', [restaurant.id]);
    assert.equal(rows.length, 1);
    assert.match(rows[0].endpoint, /flaky/);
    assert.equal(rows[0].failures, 1);
  });

  it('signing somebody out everywhere ends their notifications too', async () => {
    await subscribe('cashier');
    await subscribe('owner');
    await revokeAllSessionsForUser(staff.cashier.id);
    const { rows } = await db.query(
      'SELECT user_id FROM push_subscriptions WHERE restaurant_id = $1', [restaurant.id]);
    assert.deepEqual(rows.map(r => r.user_id), [staff.owner.id]);
  });

  it('the same phone, signed into by somebody else, becomes theirs', async () => {
    await subscribe('cashier', 'shared');
    await subscribe('waiter', 'shared');
    const { rows } = await db.query(
      'SELECT user_id FROM push_subscriptions WHERE restaurant_id = $1', [restaurant.id]);
    assert.deepEqual(rows.map(r => r.user_id), [staff.waiter.id]);
  });

  it('nobody can switch off somebody else\'s phone', async () => {
    await subscribe('cashier');
    const res = await request('DELETE', '/api/v1/push/subscriptions', {
      token: staff.waiter.token, body: { endpoint: endpointFor('cashier') }
    });
    assert.equal(res.status, 204);
    const { rowCount } = await db.query(
      'SELECT 1 FROM push_subscriptions WHERE restaurant_id = $1', [restaurant.id]);
    assert.equal(rowCount, 1);
  });

  it('the test notification goes to my phones only', async () => {
    const none = await request('POST', '/api/v1/push/test', { token: staff.owner.token });
    assert.equal(none.status, 409);
    assert.equal(none.body.error.code, 'PUSH_NOT_SUBSCRIBED');

    await subscribe('owner');
    await subscribe('cashier');
    const res = await request('POST', '/api/v1/push/test', { token: staff.owner.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sent: 1, devices: 1 });
    assert.deepEqual(delivered(), ['owner']);
  });
});
