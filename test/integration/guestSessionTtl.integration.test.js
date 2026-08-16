const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const { redis, closeRedis } = require('../../src/connectors/redis');
const { createGuestSession, resolveGuestSession } = require('../../src/services/guest');
const config = require('../../src/config');

/**
 * Session expiry against a real Redis.
 *
 * The unit test proves `expire` is called; this proves Redis honours it, which
 * is the half that decides whether a diner who sat down at eight can still pay
 * at half past ten. No Postgres involved -- a guest session lives only in
 * Redis, and `createGuestSession` never checks that the ids it is handed exist.
 */
describe('guest session expiry', { skip }, () => {
  const created = [];

  const newSession = async () => {
    const session = await createGuestSession({
      restaurantId: crypto.randomUUID(), tableId: crypto.randomUUID()
    });
    created.push(`guest:session:${session.sessionId}`);
    return session;
  };

  after(async () => {
    if (created.length) await redis.del(...created);
    await closeRedis();
  });

  it('renews the real TTL on every use', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;

    // Age the key the way two hours of dinner would.
    await redis.expire(key, 30);
    assert.ok((await redis.ttl(key)) <= 30);

    assert.ok(await resolveGuestSession(session.sessionId, session.guestToken));

    const ttl = await redis.ttl(key);
    assert.ok(ttl > 30, `expected a renewed TTL, got ${ttl}`);
    assert.ok(ttl <= config.guest.sessionTtlSeconds);
  });

  it('does not renew for a token that does not match', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;
    await redis.expire(key, 30);

    assert.equal(await resolveGuestSession(session.sessionId, 'wrong-token'), null);
    assert.ok((await redis.ttl(key)) <= 30, 'a failed attempt must not extend the credential');
  });

  it('drops a session that has passed the absolute ceiling', async () => {
    const session = await newSession();
    const key = `guest:session:${session.sessionId}`;

    const stored = JSON.parse(await redis.get(key));
    stored.createdAt = new Date(
      Date.now() - (config.guest.maxSessionAgeSeconds + 60) * 1000
    ).toISOString();
    await redis.set(key, JSON.stringify(stored), 'EX', config.guest.sessionTtlSeconds);

    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
    assert.equal(await redis.get(key), null, 'a credential known to be dead should not linger');
  });
});
