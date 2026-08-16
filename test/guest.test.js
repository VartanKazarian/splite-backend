const test = require('node:test');
const assert = require('node:assert/strict');
const { redis } = require('../src/connectors/redis');
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

const originalExpire = redis.expire.bind(redis);
const originalSet = redis.set.bind(redis);
const originalGet = redis.get.bind(redis);
const originalDel = redis.del.bind(redis);
test.afterEach(() => {
  redis.set = originalSet; redis.get = originalGet;
  redis.del = originalDel; redis.expire = originalExpire;
});

test('a guest session resolves with its own token', async () => {
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
  assert.equal(resolved.restaurantId, 'r1');
  assert.equal(resolved.tableId, 't1');
});

test('the raw guest token is never stored', async () => {
  const store = fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  const stored = [...store.values()].join('');
  assert.ok(!stored.includes(session.guestToken), 'raw token must not be persisted');
  assert.ok(JSON.parse([...store.values()][0]).tokenHash.length === 64);
});

test('a wrong token is rejected', async () => {
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  assert.equal(await resolveGuestSession(session.sessionId, 'not-the-token'), null);
});

test('a session id alone is not a credential', async () => {
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  assert.equal(await resolveGuestSession(session.sessionId, ''), null);
  assert.equal(await resolveGuestSession(session.sessionId, undefined), null);
});

test('a destroyed session no longer resolves', async () => {
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });
  await destroyGuestSession(session.sessionId);
  assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
});

test('unknown session ids resolve to null', async () => {
  fakeRedis();
  assert.equal(await resolveGuestSession('nope', 'token'), null);
});

test('using a session pushes its expiry back', async () => {
  // The bug this closes: the TTL was set once at creation and never touched, so
  // a session died two hours after the QR was scanned regardless of what the
  // diner was doing -- which is at the table, for longer than two hours, and
  // the expiry landed exactly when they opened the phone to pay.
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  assert.ok(await resolveGuestSession(session.sessionId, session.guestToken));
  assert.equal(expiries.length, 1, 'a successful read must renew the session');
  assert.equal(expiries[0].ttl, config.guest.sessionTtlSeconds);

  await resolveGuestSession(session.sessionId, session.guestToken);
  assert.equal(expiries.length, 2, 'and renew it again on the next request');
});

test('a wrong token neither resolves nor renews', async () => {
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  assert.equal(await resolveGuestSession(session.sessionId, 'not-the-token'), null);
  assert.equal(expiries.length, 0, 'a failed attempt must not extend the credential');
});

test('sliding stops at the absolute ceiling', async () => {
  // Without a cap, "renew on every use" means a session that something keeps
  // touching -- a tab open on a phone in a drawer, a client polling on a timer
  // -- never expires at all.
  fakeRedis();
  const session = await createGuestSession({ restaurantId: 'r1', tableId: 't1' });

  const key = `guest:session:${session.sessionId}`;
  const stored = JSON.parse(await redis.get(key));
  stored.createdAt = new Date(Date.now() - (config.guest.maxSessionAgeSeconds + 60) * 1000).toISOString();
  await redis.set(key, JSON.stringify(stored));

  assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
  assert.equal(await redis.get(key), null, 'a credential known to be dead should not linger');
});
