const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { redis } = require('../src/connectors/redis');
const config = require('../src/config');
const throttle = require('../src/services/loginThrottle');

const real = {
  multi: redis.multi.bind(redis),
  del: redis.del.bind(redis)
};

let store;
let failing;

beforeEach(() => {
  store = new Map();
  failing = false;

  // Enough of MULTI to serve GET/TTL/INCR/EXPIRE in the shapes this uses.
  redis.multi = () => {
    const ops = [];
    const chain = {
      get: k => (ops.push(['get', k]), chain),
      ttl: k => (ops.push(['ttl', k]), chain),
      incr: k => (ops.push(['incr', k]), chain),
      expire: (k, s) => (ops.push(['expire', k, s]), chain),
      exec: async () => {
        if (failing) throw new Error('redis down');
        return ops.map(([op, key]) => {
          if (op === 'get') return [null, store.has(key) ? String(store.get(key)) : null];
          if (op === 'ttl') return [null, store.has(key) ? 900 : -2];
          if (op === 'incr') {
            store.set(key, (store.get(key) || 0) + 1);
            return [null, store.get(key)];
          }
          return [null, 1];
        });
      }
    };
    return chain;
  };
  redis.del = async key => { if (failing) throw new Error('redis down'); return store.delete(key) ? 1 : 0; };
});

afterEach(() => {
  redis.multi = real.multi;
  redis.del = real.del;
  Object.assign(config.rateLimit, { failClosedOnAuth: config.rateLimit.failClosedOnAuth });
});

const spend = async (email, n) => {
  for (let i = 0; i < n; i++) await throttle.recordFailure(email);
};

test('lets an ordinary run of typos through', async () => {
  await spend('owner@example.com', config.auth.maxAccountFailures - 1);
  await throttle.assertNotThrottled('owner@example.com');
});

test('refuses once the threshold is reached', async () => {
  await spend('owner@example.com', config.auth.maxAccountFailures);
  await assert.rejects(
    () => throttle.assertNotThrottled('owner@example.com'),
    err => {
      // The same code the address limiter returns, so a caller cannot tell
      // which limit they hit and therefore cannot learn anything from it.
      assert.equal(err.code, 'RATE_LIMITED');
      assert.ok(err.details.retryAfterSeconds > 0);
      return true;
    }
  );
});

test('throttles one account without touching another', async () => {
  await spend('victim@example.com', config.auth.maxAccountFailures);
  await throttle.assertNotThrottled('someone-else@example.com');
});

test('counts an address that has no account at all', async () => {
  // The anti-enumeration property. If only real accounts were counted, then
  // "this address can be throttled and that one cannot" is exactly the oracle
  // the decoy hash in login() exists to deny.
  await spend('nobody-has-this@example.com', config.auth.maxAccountFailures);
  await assert.rejects(
    () => throttle.assertNotThrottled('nobody-has-this@example.com'),
    err => err.code === 'RATE_LIMITED'
  );
});

test('a successful login clears the count', async () => {
  // Without this, a member of staff who mistypes their password all morning
  // arrives at the threshold and is locked out despite knowing it.
  await spend('owner@example.com', config.auth.maxAccountFailures - 1);
  await throttle.clearFailures('owner@example.com');
  await spend('owner@example.com', 1);
  await throttle.assertNotThrottled('owner@example.com');
});

test('normalises the address, so spelling cannot buy more attempts', async () => {
  await spend('Owner@Example.com ', config.auth.maxAccountFailures);
  await assert.rejects(
    () => throttle.assertNotThrottled('owner@example.com'),
    err => err.code === 'RATE_LIMITED'
  );
});

test('keeps the address out of the Redis key', async () => {
  // Keys surface in logs, dashboards and KEYS output; this one is somebody's
  // email address.
  const key = throttle.keyFor('owner@example.com');
  assert.ok(!key.includes('owner'), key);
  assert.ok(!key.includes('@'), key);
  assert.match(key, /^auth:acct:[a-f0-9]{64}$/);
});

test('a write failure never fails the attempt itself', async () => {
  // The attempt has already been judged on its merits and audited to Postgres.
  failing = true;
  await throttle.recordFailure('owner@example.com');
  await throttle.clearFailures('owner@example.com');
});

test('an unavailable backend follows the auth fail-closed setting', async () => {
  failing = true;

  config.rateLimit.failClosedOnAuth = true;
  await assert.rejects(
    () => throttle.assertNotThrottled('owner@example.com'),
    err => err.code === 'RATE_LIMITER_UNAVAILABLE'
  );

  // And when the deployment has chosen availability over that protection, this
  // must not be the thing that overrides the choice.
  config.rateLimit.failClosedOnAuth = false;
  await throttle.assertNotThrottled('owner@example.com');
  config.rateLimit.failClosedOnAuth = true;
});
