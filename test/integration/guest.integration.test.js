const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const { redis, connectRedis, closeRedis } = require('../../src/connectors/redis');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const {
  createGuestSession,
  resolveGuestSession,
  destroyGuestSession
} = require('../../src/services/guest');

describe('guest sessions against a real Redis', { skip }, () => {
  // Real rows rather than fabricated ids: a session now carries a composite
  // foreign key to (table_id, restaurant_id), so the pairing is checked by the
  // database instead of trusted from the caller.
  let restaurantId;
  let tableId;
  const created = [];

  before(async () => {
    await connectRedis();
    const restaurant = await fixtures.createRestaurant({ name: 'Guest Redis Tenant' });
    restaurantId = restaurant.id;
    tableId = (await fixtures.createTable(restaurantId, { name: 'GR1' })).id;
  });

  after(async () => {
    for (const sessionId of created) await redis.del(`guest:session:${sessionId}`);
    await db.query('DELETE FROM guest_sessions WHERE restaurant_id = $1', [restaurantId]);
    await fixtures.destroyRestaurant(restaurantId);
    await db.close();
    await closeRedis();
  });

  const track = (session) => {
    created.push(session.sessionId);
    return session;
  };

  it('round-trips a session with its own token', async () => {
    const session = track(await createGuestSession({ restaurantId, tableId }));

    const resolved = await resolveGuestSession(session.sessionId, session.guestToken);
    assert.ok(resolved);
    assert.equal(resolved.restaurantId, restaurantId);
    assert.equal(resolved.tableId, tableId);
  });

  it('never stores the raw token', async () => {
    const session = track(await createGuestSession({ restaurantId, tableId }));

    const raw = await redis.get(`guest:session:${session.sessionId}`);
    assert.ok(raw, 'the session exists');
    assert.ok(!raw.includes(session.guestToken), 'the raw token is absent from Redis');

    const stored = JSON.parse(raw);
    assert.equal(stored.tokenHash.length, 64, 'a SHA-256 hex digest is stored instead');
  });

  it('refuses a session id presented without its token', async () => {
    const session = track(await createGuestSession({ restaurantId, tableId }));

    assert.equal(await resolveGuestSession(session.sessionId, 'not-the-token'), null);
    assert.equal(await resolveGuestSession(session.sessionId, ''), null);
    assert.equal(await resolveGuestSession(session.sessionId, undefined), null);
  });

  it('does not accept one session\'s token for another session', async () => {
    const a = track(await createGuestSession({ restaurantId, tableId }));
    const b = track(await createGuestSession({ restaurantId, tableId }));

    assert.equal(await resolveGuestSession(a.sessionId, b.guestToken), null);
    assert.equal(await resolveGuestSession(b.sessionId, a.guestToken), null);
  });

  it('stops resolving once destroyed', async () => {
    const session = track(await createGuestSession({ restaurantId, tableId }));
    await destroyGuestSession(session.sessionId);

    assert.equal(await resolveGuestSession(session.sessionId, session.guestToken), null);
  });

  it('applies a TTL so abandoned sessions expire on their own', async () => {
    const session = track(await createGuestSession({ restaurantId, tableId }));

    const ttl = await redis.ttl(`guest:session:${session.sessionId}`);
    assert.ok(ttl > 0, 'the key carries an expiry rather than living forever');
  });
});
