const test = require('node:test');
const assert = require('node:assert/strict');
const { redis } = require('../src/connectors/redis');
const { createGuestSession, resolveGuestSession, destroyGuestSession } = require('../src/services/guest');

function fakeRedis() {
  const store = new Map();
  redis.set = async (key, value) => { store.set(key, value); return 'OK'; };
  redis.get = async key => store.get(key) ?? null;
  redis.del = async key => (store.delete(key) ? 1 : 0);
  return store;
}

const originalSet = redis.set.bind(redis);
const originalGet = redis.get.bind(redis);
const originalDel = redis.del.bind(redis);
test.afterEach(() => { redis.set = originalSet; redis.get = originalGet; redis.del = originalDel; });

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
