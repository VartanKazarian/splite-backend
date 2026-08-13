const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const config = require('../../src/config');
const { document } = require('../../src/openapi');

/**
 * Guest bill access, over HTTP.
 *
 * This is the least trusted surface in the API: the credential is handed out by
 * scanning a sticker. The cases that matter are therefore less about the happy
 * path than about what a guest holding a valid session for one table can reach.
 */
describe('guest bill access', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let table;
  let seq = 0;
  let staffToken;

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

  /**
   * Builds a QR payload the way the route does.
   *
   * `exp` is omitted when no TTL is configured, rather than set to `now + 0`.
   * That is not cosmetic: a token stamped `exp = now` is valid for less than a
   * second, so this suite passed locally and failed on a slower CI runner
   * whenever minting and verifying landed either side of a second boundary.
   */
  const mintQr = (tableRow) => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    return signQrPayload({
      v: 1,
      tableId: tableRow.id,
      restaurantId: tableRow.restaurant_id ?? restaurant.id,
      nonce: tableRow.qr_nonce,
      iat: now,
      ...(ttl > 0 ? { exp: now + ttl } : {})
    });
  };

  /** Scans the table's QR the way a phone would, and returns the session. */
  const scan = async (tableRow) => {
    const qrToken = mintQr(tableRow);
    const res = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { session: res.body.sessionId, token: res.body.guestToken };
  };

  const tableWithNonce = async (name) => {
    const created = await fixtures.createTable(restaurant.id, { name });
    const { rows } = await db.query('SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id]);
    return rows[0];
  };


  /**
   * These suites drive real HTTP, so every request in them comes from
   * 127.0.0.1 against an app-level limit of 120 a minute. The limiter is
   * correct -- the harness is what shares one address across a hundred
   * requests -- so the buckets are cleared before each test rather than once
   * per suite, which stopped being enough as the suites grew.
   */
  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1',
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );

  beforeEach(clearIpRateLimits);

  before(async () => {
    // Guest routes are limited to 30 requests a minute per IP, and this suite
    // shares 127.0.0.1 with every other HTTP test. Clearing the bucket isolates
    // the run from whatever else has already spent it.
    await clearIpRateLimits();

    restaurant = await fixtures.createRestaurant({ name: 'Guest Tenant' });
    table = await tableWithNonce(`G${++seq}`);

    // Minting a QR is staff-only, so this suite needs one staff credential
    // alongside its guest sessions.
    const { hashPassword } = require('../../src/services/auth');
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER') RETURNING id`,
      [restaurant.id, `guest-staff-${restaurant.id}@example.com`, await hashPassword('irrelevant-here-123')]
    );
    staffToken = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('reads the open bill for the scanned table', async () => {
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 5000
    });
    const guest = await scan(table);

    const res = await request('GET', '/api/v1/guest/bill', guest);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.id, bill.id);
    assert.equal(res.body.totalDueVes, '5000');
    assert.equal(res.body.remainingVes, '5000');

    await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [bill.id]);
  });

  it('withholds the fields a diner has no business seeing', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 1000 });
    const guest = await scan(t);

    const res = await request('GET', '/api/v1/guest/bill', guest);
    assert.equal(res.status, 200);

    // The staff DTO carries these; the guest one is a narrower allowlist.
    for (const field of ['restaurantId', 'calculationVersion', 'fxRateSource', 'fxValueDate', 'createdAt']) {
      assert.equal(res.body[field], undefined, `${field} must not reach a guest`);
    }
    assert.deepEqual(Object.keys(res.body).filter(k => k.includes('_')), [], 'camelCase here too');
  });

  it('publishes every field the GuestBill schema promises', async () => {
    // The withholding test above checks the allowlist from one side only, and a
    // one-sided allowlist is how this broke in production: dto.guestBill mapped
    // `row.subtotal_minor`, the route's SELECT never fetched the column, the
    // mapper produced `undefined`, and JSON.stringify dropped the key without a
    // sound. The documented contract said the field was there; the response did
    // not have it, and the client crashed formatting it.
    //
    // Asserting against the OpenAPI properties rather than a hand-copied list is
    // what makes this hold: adding a field to the schema without adding it to
    // the SELECT fails here instead of on a diner's phone.
    const t = await tableWithNonce(`G${++seq}`);
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 1000 });
    const guest = await scan(t);

    const res = await request('GET', '/api/v1/guest/bill', guest);
    assert.equal(res.status, 200);

    const promised = Object.keys(document.components.schemas.GuestBill.properties);
    const missing = promised.filter(k => res.body[k] === undefined);
    assert.deepEqual(missing, [], `GuestBill schema promises fields the route does not send`);

    const undocumented = Object.keys(res.body).filter(k => !promised.includes(k));
    assert.deepEqual(undocumented, [], 'the route sends fields the schema does not document');
  });

  it('cannot reach another table\'s bill, because it never names one', async () => {
    // The guest session is bound to its own table, and the route takes no bill
    // id, so there is no identifier to substitute. Holding a valid session for
    // table A must simply never surface table B.
    const mine = await tableWithNonce(`G${++seq}`);
    const theirs = await tableWithNonce(`G${++seq}`);
    const theirBill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: theirs.id, totalDue: 9999
    });

    const guest = await scan(mine);
    const res = await request('GET', '/api/v1/guest/bill', guest);

    // My table has no open bill, so this is a 404 -- not their bill.
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'OPEN_BILL_NOT_FOUND');

    await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [theirBill.id]);
  });

  it('cannot reach another restaurant\'s bill', async () => {
    // Table ids are globally unique, so the table_id predicate alone already
    // scopes this correctly and the restaurant_id predicate is defence in
    // depth. The test exists so that stays true: if table identity ever became
    // per-restaurant, this is what would catch it.
    const other = await fixtures.createRestaurant({ name: 'Other Guest Tenant' });
    try {
      const theirTable = await fixtures.createTable(other.id);
      await fixtures.createBill({ restaurantId: other.id, tableId: theirTable.id, totalDue: 7777 });

      const mine = await tableWithNonce(`G${++seq}`);
      await fixtures.createBill({ restaurantId: restaurant.id, tableId: mine.id, totalDue: 1111 });
      const guest = await scan(mine);

      const res = await request('GET', '/api/v1/guest/bill', guest);
      assert.equal(res.status, 200);
      assert.equal(res.body.totalDueVes, '1111', 'my own bill, never the other tenant\'s');
      assert.notEqual(res.body.totalDueVes, '7777');
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('refuses a missing, malformed or mismatched session', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 1000 });
    const guest = await scan(t);

    const none = await request('GET', '/api/v1/guest/bill');
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, 'GUEST_SESSION_MISSING');

    // A real session id with the wrong token must not authenticate: the token
    // is compared against a stored hash, not merely presented.
    const wrongToken = await request('GET', '/api/v1/guest/bill', {
      session: guest.session, token: 'not-the-right-token'
    });
    assert.equal(wrongToken.status, 401);
    assert.equal(wrongToken.body.error.code, 'GUEST_SESSION_INVALID');

    const wrongSession = await request('GET', '/api/v1/guest/bill', {
      session: '11111111-1111-4111-8111-111111111111', token: guest.token
    });
    assert.equal(wrongSession.status, 401);
  });

  it('mints the same code every time, until the nonce rotates', async () => {
    // A sticker on a table cannot change when someone refreshes the dashboard.
    // The token used to carry `iat`, which made it a function of the clock and
    // produced a different image on every mint -- valid, but not the code
    // already stuck to the table.
    const t = await tableWithNonce(`G${++seq}`);

    const mint = async () => {
      const res = await request('GET', `/api/v1/guest/tables/${t.id}/qr`, { token: staffToken });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body.token;
    };

    const first = await mint();
    await new Promise(resolve => setTimeout(resolve, 1100)); // cross a second boundary
    const second = await mint();

    // Asserted against the configured mode rather than assuming one. A
    // deployment that sets QR_TTL_SECONDS is minting time-bounded codes, and
    // those are *supposed* to differ per mint; permanent codes, the default and
    // what production runs, must not.
    if (config.qrTtlSeconds > 0) {
      assert.notEqual(first, second, 'a time-bounded code carries iat/exp and differs per mint');
    } else {
      assert.equal(first, second, 'the same table and nonce must mint the same code');

      // Rotating the nonce is the one thing that changes a permanent code.
      await request('POST', `/api/v1/guest/tables/${t.id}/qr/rotate`, { token: staffToken });
      assert.notEqual(await mint(), first, 'rotation must produce a new code');
    }
  });

  it('a rotated QR stops working immediately', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    const stale = mintQr(t);

    // Reprinting the code rotates the nonce; anything already printed dies.
    await db.query('UPDATE tables SET qr_nonce = gen_random_uuid() WHERE id = $1', [t.id]);

    const res = await request('POST', '/api/v1/guest/sessions', { body: { qrToken: stale } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'QR_INVALID');
  });

  it('splits its own bill with the same engine staff use', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 10000 });
    const guest = await scan(t);

    const res = await request('POST', '/api/v1/guest/bill/split/preview', {
      ...guest,
      body: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const summed = res.body.allocations.reduce((total, a) => total + BigInt(a.amountVes), 0n);
    assert.equal(summed.toString(), res.body.outstandingVes);
    assert.deepEqual(res.body.allocations.map(a => a.amountVes), ['3334', '3333', '3333']);
  });

  it('a guest split moves no money', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    const bill = await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 4000 });
    const guest = await scan(t);

    const before = await fixtures.readBill(bill.id);
    await request('POST', '/api/v1/guest/bill/split/preview', {
      ...guest, body: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }
    });
    assert.deepEqual(await fixtures.readBill(bill.id), before);
  });

  it('ending a session revokes it', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 1000 });
    const guest = await scan(t);

    assert.equal((await request('GET', '/api/v1/guest/bill', guest)).status, 200);
    assert.equal((await request('DELETE', '/api/v1/guest/sessions', guest)).status, 204);

    const after = await request('GET', '/api/v1/guest/bill', guest);
    assert.equal(after.status, 401, 'the token stops working the moment the session ends');
    assert.equal(after.body.error.code, 'GUEST_SESSION_INVALID');
  });

  it('cannot reach any staff endpoint with a guest credential', async () => {
    const t = await tableWithNonce(`G${++seq}`);
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: t.id, totalDue: 1000 });
    const guest = await scan(t);

    // A guest token is not a staff JWT, and the staff routers do not accept the
    // guest scheme at all. Each of these must be refused on authentication
    // rather than merely finding nothing.
    for (const [method, path] of [
      ['GET', '/api/v1/bills'],
      ['GET', '/api/v1/tables'],
      ['GET', '/api/v1/menu/products'],
      ['GET', '/api/v1/menu/settings']
    ]) {
      const res = await request(method, path, guest);
      assert.equal(res.status, 401, `${method} ${path} accepted a guest credential`);
    }
  });
});
