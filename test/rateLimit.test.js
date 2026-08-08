const test = require('node:test');
const assert = require('node:assert/strict');
const { redis } = require('../src/connectors/redis');
const rateLimit = require('../src/middleware/rateLimit');

/** Minimal in-memory stand-in for the Redis commands the limiter uses. */
function fakeRedis({ fail = false } = {}) {
  const counts = new Map();
  const ttls = new Map();
  redis.multi = () => {
    const ops = [];
    const chain = {
      incr(key) { ops.push(['incr', key]); return chain; },
      ttl(key) { ops.push(['ttl', key]); return chain; },
      async exec() {
        if (fail) throw new Error('Redis unavailable');
        return ops.map(([op, key]) => {
          if (op === 'incr') { counts.set(key, (counts.get(key) || 0) + 1); return [null, counts.get(key)]; }
          return [null, ttls.has(key) ? ttls.get(key) : -1];
        });
      }
    };
    return chain;
  };
  redis.expire = async (key, seconds) => { ttls.set(key, seconds); return 1; };
  return { counts, ttls };
}

function fakeRes() {
  return {
    statusCode: null, payload: null, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; }
  };
}

const req = { ip: '203.0.113.9' };

const originalMulti = redis.multi.bind(redis);
const originalExpire = redis.expire.bind(redis);
test.afterEach(() => { redis.multi = originalMulti; redis.expire = originalExpire; });

test('requests under the limit pass and expose remaining budget', async () => {
  fakeRedis();
  const mw = rateLimit({ windowSeconds: 60, max: 3, keyPrefix: 'test' });
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(res.headers['X-RateLimit-Limit'], '3');
  assert.equal(res.headers['X-RateLimit-Remaining'], '2');
});

test('the window TTL is applied on the first hit', async () => {
  const store = fakeRedis();
  const mw = rateLimit({ windowSeconds: 45, max: 5, keyPrefix: 'ttl' });
  await mw(req, fakeRes(), () => {});
  assert.equal(store.ttls.get('ttl:203.0.113.9'), 45);
});

test('exceeding the limit returns 429 with Retry-After', async () => {
  fakeRedis();
  const mw = rateLimit({ windowSeconds: 60, max: 2, keyPrefix: 'burst' });
  await mw(req, fakeRes(), () => {});
  await mw(req, fakeRes(), () => {});
  const res = fakeRes();
  let passed = false;
  await mw(req, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers['Retry-After'], '60');
});

test('a Redis outage fails open by default', async () => {
  fakeRedis({ fail: true });
  const res = fakeRes();
  let passed = false;
  await rateLimit({ keyPrefix: 'open' })(req, res, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(res.statusCode, null);
});

test('a Redis outage fails closed when failClosed is set', async () => {
  fakeRedis({ fail: true });
  const res = fakeRes();
  let passed = false;
  await rateLimit({ keyPrefix: 'closed', failClosed: true })(req, res, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(res.statusCode, 503);
});
