const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const config = require('../../src/config');
const { hashPassword } = require('../../src/services/auth');
const { keyFor } = require('../../src/services/loginThrottle');

/**
 * Per-account login throttling, through the real route.
 *
 * The address limiter on /api/v1/auth is cleared between attempts here on
 * purpose. It allows ten a minute and would otherwise be the thing refusing
 * these requests, so the test would pass while measuring the wrong limiter --
 * which is the failure mode that makes a security test worthless.
 */
describe('login throttling', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;

  const PASSWORD = 'a-perfectly-fine-password';
  const email = `throttle-${Date.now()}@splite.example.com`;

  const clearAddressLimiter = () => redis.del(
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1',
    'api:::ffff:127.0.0.1', 'api:127.0.0.1'
  );

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    restaurant = await fixtures.createRestaurant({ name: `Throttle ${Date.now()}` });
    await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [restaurant.id, email, await hashPassword(PASSWORD)]
    );
  });

  beforeEach(async () => {
    await clearAddressLimiter();
    await redis.del(keyFor(email), keyFor('ghost@splite.example.com'));
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await redis.del(keyFor(email), keyFor('ghost@splite.example.com'));
    await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const attempt = async (address, password) => {
    await clearAddressLimiter();
    const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: address, password })
    });
    const body = await res.text();
    return { status: res.status, body: body ? JSON.parse(body) : null };
  };

  /** Spends the account's budget without asserting anything about each step. */
  const exhaust = address =>
    redis.set(keyFor(address), String(config.auth.maxAccountFailures), 'EX', 900);

  it('refuses further attempts once an account has failed too often', async () => {
    // Spread over as many addresses as an attacker likes: the counter is on the
    // account, and the address limiter is cleared between each of these.
    await exhaust(email);

    const res = await attempt(email, 'wrong-password-entirely');
    assert.equal(res.status, 429);
    assert.equal(res.body.error.code, 'RATE_LIMITED');
    assert.ok(res.body.error.details.retryAfterSeconds > 0);
  });

  it('refuses the right password too, while the count stands', async () => {
    // Deliberate, and the reason the threshold is generous and the window
    // short: a throttle that let the correct password through would not be a
    // throttle at all, since the attacker's goal *is* the correct password.
    await exhaust(email);

    const res = await attempt(email, PASSWORD);
    assert.equal(res.status, 429);
  });

  it('answers identically for a real address and an imaginary one', async () => {
    // The enumeration test, and the comparison has to be made at *equal state*
    // or it proves nothing. An earlier version exhausted only the imaginary
    // address and then expected the real one to be throttled too, which tested
    // my bookkeeping rather than the property.
    const ghost = 'ghost@splite.example.com';

    // Below the threshold: both refused the same way.
    const ghostBelow = await attempt(ghost, 'anything-at-all');
    const realBelow = await attempt(email, 'wrong-password-entirely');
    assert.equal(ghostBelow.status, 401);
    assert.equal(realBelow.status, 401);
    assert.equal(ghostBelow.body.error.code, realBelow.body.error.code);

    // And at the threshold: both throttled the same way, so a caller cannot
    // learn which addresses have accounts by which of them can be throttled.
    await exhaust(ghost);
    await exhaust(email);

    const ghostOver = await attempt(ghost, 'anything-at-all');
    const realOver = await attempt(email, 'wrong-password-entirely');

    assert.equal(ghostOver.status, 429);
    assert.equal(realOver.status, 429);
    assert.equal(ghostOver.body.error.code, realOver.body.error.code);
    assert.deepEqual(
      Object.keys(ghostOver.body.error).sort(),
      Object.keys(realOver.body.error).sort()
    );
  });

  it('counts real failures and clears them on a real login', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await attempt(email, 'wrong-password-entirely');
      assert.equal(res.status, 401, 'below the threshold this is an ordinary refusal');
    }
    assert.equal(await redis.get(keyFor(email)), '3');

    const ok = await attempt(email, PASSWORD);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(
      await redis.get(keyFor(email)), null,
      'a password that works proves the failures were somebody getting it wrong'
    );
  });

  it('recovers on its own, with no administrator in the loop', async () => {
    // The property that keeps this from becoming the attack: anyone who knows
    // an owner's email could otherwise shut a restaurant out of its own till.
    await exhaust(email);
    assert.equal((await attempt(email, PASSWORD)).status, 429);

    const ttl = await redis.ttl(keyFor(email));
    assert.ok(ttl > 0 && ttl <= config.auth.accountFailureWindowSeconds, `ttl was ${ttl}`);

    // Simulate the window elapsing rather than waiting fifteen minutes for it.
    await redis.del(keyFor(email));
    assert.equal((await attempt(email, PASSWORD)).status, 200);
  });
});
