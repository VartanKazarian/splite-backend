const test = require('node:test');
const assert = require('node:assert/strict');
const { redis } = require('../src/connectors/redis');
const db = require('../src/connectors/base');
const { createGuestSession, resolveGuestSession, destroyGuestSession } = require('../src/services/guest');
const config = require('../src/config');

const expiries = [];

function fakeRedis() {
  expiries.length = 0;
  const store = new Map();
  redis.set = async (key, value) => { store.set(key, value); return 'OK'; };
  redis.get = async key => store.get(key) ?? null;
  redis.del = async key => (store.delete(key) ? 1 : 0);
  // Sliding expiry. The in-memory store has no notion of TTL, so this records
  // that the expiry was pushed back without pretending to enforce it -- without
  // the stub, resolveGuestSession reaches for a real Redis and the unit suite
  // hangs on ioredis retrying a connection that is not there.
  redis.expire = async (key, ttl) => { expiries.push({ key, ttl }); return 1; };
  return store;
}

/**
 * The durable half, in memory.
 *
 * Matched on the query text rather than parsed: there are three statements and
 * they are the ones directly above in the service, so a stub that recognises
 * them by name says more about what is being exercised than a SQL parser would.
 * The integration suite runs the real thing.
 */
function fakeDb() {
  const rows = [];
  db.query = async (text, params = []) => {
    if (text.includes('INSERT INTO guest_sessions')) {
      const [id, restaurantId, tableId, tokenHash, maxAgeSeconds, userAgent, ip] = params;
      rows.push({
        id,
        restaurant_id: restaurantId,
        table_id: tableId,
        token_hash: tokenHash,
        expires_at: new Date(Date.now() + maxAgeSeconds * 1000),
        revoked_at: null,
        user_agent: userAgent,
        ip
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM guest_sessions')) {
      const found = rows.filter(r =>
        r.id === params[0] && r.revoked_at === null && r.expires_at > new Date());
      return { rows: found, rowCount: found.length };
    }
    if (text.includes('UPDATE guest_sessions')) {
      const row = rows.find(r => r.id === params[0]);
      if (row) row.revoked_at = new Date();
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected query in the guest stub: ${text}`);
  };
  return rows;
}

const originalExpire = redis.expire.bind(redis);
const originalSet = redis.set.bind(redis);
const originalGet = redis.get.bind(redis);
const originalDel = redis.del.bind(redis);
const originalQuery = db.query.bind(db);
test.afterEach(() => {
  redis.set = originalSet; redis.get = originalGet;
  redis.del = originalDel; redis.expire = originalExpire;
  db.query = originalQuery;
});

test('a guest session resolves with its own token', async () => {
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
  assert.equal(resolved.restaurantId, 'r1');
  assert.equal(resolved.tableId, 't1');
});

test('the raw guest token is never stored', async () => {
  const store = fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  const stored = [...store.values()].join('');
  assert.ok(!stored.includes(session.guestToken), 'raw token must not be persisted');
  assert.ok(JSON.parse([...store.values()][0]).tokenHash.length === 64);
});

test('a wrong token is rejected', async () => {
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  assert.equal(await resolveGuestSession(session.sessionId, 'not-the-token'), null);
});

test('a session id alone is not a credential', async () => {
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  assert.equal(await resolveGuestSession(session.sessionId, ''), null);
  assert.equal(await resolveGuestSession(session.sessionId, undefined), null);
});

test('a destroyed session no longer resolves', async () => {
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  await destroyGuestSession(session.sessionId);
  assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
});

test('unknown session ids resolve to null', async () => {
  fakeRedis();
  fakeDb();
  assert.equal(await resolveGuestSession('nope', 'token'), null);
});

test('using a session pushes its expiry back', async () => {
  // The bug this closes: the TTL was set once at creation and never touched, so
  // a session died two hours after the QR was scanned regardless of what the
  // diner was doing -- which is at the table, for longer than two hours, and
  // the expiry landed exactly when they opened the phone to pay.
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  assert.ok(await resolveGuestSession(session.sessionId, session.guestToken));
  assert.equal(expiries.length, 1, 'a successful read must renew the session');
  assert.equal(expiries[0].ttl, config.guest.sessionTtlSeconds);

  await resolveGuestSession(session.sessionId, session.guestToken);
  assert.equal(expiries.length, 2, 'and renew it again on the next request');
});

test('a wrong token neither resolves nor renews', async () => {
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  assert.equal(await resolveGuestSession(session.sessionId, 'not-the-token'), null);
  assert.equal(expiries.length, 0, 'a failed attempt must not extend the credential');
});

test('sliding stops at the absolute ceiling', () => {
  // Without a cap, "renew on every use" means a session that something keeps
  // touching -- a tab open on a phone in a drawer, a client polling on a timer
  // -- never expires at all.
  //
  // The cap moved to Postgres with the rest of the durable facts, so it is now
  // a predicate on the row rather than a date carried in the cache entry, and
  // it is proved against a real database in the integration suite. What is
  // asserted here is that the two numbers still say what they are supposed to:
  // the idle timeout must be the shorter of the two, or sliding would outlive
  // the ceiling meant to bound it.
  assert.ok(
    config.guest.sessionTtlSeconds < config.guest.maxSessionAgeSeconds,
    'the idle timeout has to be shorter than the absolute cap'
  );
});

test('a flushed cache does not sign a diner out', async () => {
  // The whole reason the row exists. Redis was the only record, so a restart, a
  // FLUSHALL or an eviction under maxmemory signed out every diner in every
  // restaurant -- and they could not recover, because the client strips the QR
  // token out of the URL once it has been exchanged.
  const store = fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  store.clear();

  const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
  assert.ok(resolved, 'the session survives the cache');
  assert.equal(resolved.restaurantId, 'r1');
  assert.equal(resolved.tableId, 't1');

  // And the cache is warmed on the way through, so an outage costs one query
  // per session rather than one per request.
  assert.equal(store.size, 1);
});

test('a session survives Redis being down entirely', async () => {
  // Not a miss: a throw. ioredis rejects rather than returning null when it
  // cannot reach the server, and that used to reach the route as a 500.
  fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  redis.get = async () => { throw new Error('ECONNREFUSED'); };
  redis.set = async () => { throw new Error('ECONNREFUSED'); };

  const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
  assert.ok(resolved, 'Postgres answers when the cache cannot');
  assert.equal(resolved.tableId, 't1');
});

test('a revoked session stays revoked when the cache is flushed', async () => {
  // Deleting the cache entry alone would mean a flush resurrects a session
  // somebody deliberately ended, by re-reading a row that never said so.
  const store = fakeRedis();
  fakeDb();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  await destroyGuestSession(session.sessionId);
  store.clear();

  assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
});

test('a malformed session id is refused before it reaches Postgres', async () => {
  // It arrives in a header and is typed uuid in the query. Anything else raises
  // invalid input syntax, which would be a 500 on a request whose only fault is
  // a bad header -- and a way for an unauthenticated caller to write error
  // lines.
  fakeRedis();
  db.query = async () => { throw new Error('the store must not be asked'); };

  assert.equal(await resolveGuestSession('not-a-uuid', 'token'), null);
  assert.equal(await resolveGuestSession('../../etc/passwd', 'token'), null);
  await destroyGuestSession('not-a-uuid');
});
