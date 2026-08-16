const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload } = require('../../src/utils/tokens');

/**
 * Rate limiting on the diner-facing surface.
 *
 * The property under test is that two diners at one restaurant do not share a
 * bucket. They reach us from a single carrier NAT address, so a per-IP limit
 * throttles a busy Friday rather than an abuser.
 *
 * The budget is spent by seeding the counter rather than by sending sixty
 * requests. Driving a real limiter to its ceiling also drains the shared
 * per-address buckets this process has in common with every other suite -- the
 * first version of this file did exactly that and failed five tests in
 * guest.integration.test.js, which was the test being wrong about its
 * environment rather than the code being wrong.
 */
describe('guest rate limiting', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  const tables = [];

  const PER_SESSION_MAX = 60;   // mirrors the limiter in src/routes/guest.js

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Limits ${Date.now()}` });
    for (const name of ['L1', 'L2']) {
      tables.push(await fixtures.createTable(restaurant.id, { name }));
    }
  });

  beforeEach(async () => {
    const keys = await redis.keys('guest:rl:*');
    if (keys.length) await redis.del(...keys);
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    const keys = await redis.keys('guest:rl:*');
    if (keys.length) await redis.del(...keys);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const scan = async table => {
    const { rows } = await db.query('SELECT qr_nonce FROM tables WHERE id = $1', [table.id]);
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: restaurant.id, nonce: rows[0].qr_nonce
    });
    const res = await fetch(`${baseUrl}/api/v1/guest/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qrToken })
    });
    // Read the body once. A template literal in the assert message is evaluated
    // whether or not the assertion fails, so building it from res.text() there
    // consumes the body and the res.json() below throws instead.
    const body = await res.text();
    assert.equal(res.status, 201, `scan failed: ${body}`);
    return JSON.parse(body);
  };

  const readBill = session => fetch(`${baseUrl}/api/v1/guest/bill`, {
    headers: {
      authorization: `Bearer ${session.guestToken}`,
      'x-guest-session': session.sessionId
    }
  });

  /**
   * Spends a session's budget without generating the traffic.
   *
   * The counter lives under `guest:rl:`, deliberately not `guest:session:` --
   * that is where the sessions themselves are stored, and pointing the limiter
   * at it made the counter and the credential the same key.
   */
  const exhaust = async sessionId => {
    await redis.set(`guest:rl:${sessionId}`, String(PER_SESSION_MAX + 1), 'EX', 60);
  };

  it('throttles one session without touching the table next to it', async () => {
    const busy = await scan(tables[0]);
    const quiet = await scan(tables[1]);

    await exhaust(busy.sessionId);

    assert.equal((await readBill(busy)).status, 429, 'the spent session must be refused');

    // Same address, same second, different session.
    const neighbour = await readBill(quiet);
    assert.notEqual(
      neighbour.status, 429,
      'one diner exhausting their budget must not throttle the next table'
    );
  });

  it('keys the bucket on the session, not the credential holder\'s address', async () => {
    const session = await scan(tables[0]);
    await readBill(session);

    // If the limiter were still keyed on IP there would be no such key, and a
    // key named for the address instead.
    const keyed = await redis.exists(`guest:rl:${session.sessionId}`);
    assert.equal(keyed, 1, 'the counter should be named for the session');
  });
});
