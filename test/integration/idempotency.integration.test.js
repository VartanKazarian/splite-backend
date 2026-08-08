const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { begin, complete, abort, purgeExpired } = require('../../src/services/idempotency');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('idempotency keys against a real Postgres', { skip }, () => {
  let restaurant;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Idempotency Tenant' });
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  it('grants the claim to exactly one of several concurrent requests', async () => {
    const key = `concurrent-${crypto.randomUUID()}`;
    const requestHash = hash('same-payload');

    // The unit suite cannot observe this: the guarantee comes from the
    // (restaurant_id, key) unique index and ON CONFLICT DO NOTHING, which only
    // exists in a real database.
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash })
      )
    );

    const owners = attempts.filter(a => a.status === 'fulfilled' && a.value.owner === true);
    const conflicts = attempts.filter(a => a.status === 'rejected');

    assert.equal(owners.length, 1, 'exactly one request may charge the card');
    assert.equal(conflicts.length, 5);
    for (const c of conflicts) assert.equal(c.reason.statusCode, 409);
  });

  it('replays the stored response instead of charging twice', async () => {
    const key = `replay-${crypto.randomUUID()}`;
    const requestHash = hash('payload-a');

    const first = await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    assert.equal(first.owner, true);

    await complete({
      restaurantId: restaurant.id,
      key,
      status: 200,
      body: { id: 'bill-1', status: 'CLOSED', amountPaid: '5000' }
    });

    const retry = await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    assert.equal(retry.owner, false);
    assert.equal(retry.response.status, 200);
    assert.deepEqual(retry.response.body, { id: 'bill-1', status: 'CLOSED', amountPaid: '5000' });
  });

  it('rejects the same key carrying a different payload', async () => {
    const key = `mismatch-${crypto.randomUUID()}`;
    await begin({ restaurantId: restaurant.id, userId: null, key, hash: hash('original') });

    await assert.rejects(
      () => begin({ restaurantId: restaurant.id, userId: null, key, hash: hash('tampered') }),
      err => {
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /different request payload/);
        return true;
      }
    );
  });

  it('releases an aborted claim so the client can retry', async () => {
    const key = `abort-${crypto.randomUUID()}`;
    const requestHash = hash('payload-b');

    await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    await abort({ restaurantId: restaurant.id, key });

    const retry = await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    assert.equal(retry.owner, true, 'the key is claimable again after an abort');
  });

  it('does not abort a claim that already stored a response', async () => {
    const key = `abort-completed-${crypto.randomUUID()}`;
    const requestHash = hash('payload-c');

    await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    await complete({ restaurantId: restaurant.id, key, status: 200, body: { ok: true } });
    await abort({ restaurantId: restaurant.id, key });

    const retry = await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    assert.equal(retry.owner, false, 'a completed key survives an abort');
    assert.deepEqual(retry.response.body, { ok: true });
  });

  it('reclaims an expired in-flight key', async () => {
    const key = `expired-${crypto.randomUUID()}`;
    const requestHash = hash('payload-d');

    await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    // Simulate a request that died mid-flight 25 hours ago.
    await db.query(
      'UPDATE idempotency_keys SET expires_at = NOW() - INTERVAL \'1 hour\' WHERE restaurant_id = $1 AND key = $2',
      [restaurant.id, key]
    );

    const retry = await begin({ restaurantId: restaurant.id, userId: null, key, hash: requestHash });
    assert.equal(retry.owner, true, 'an abandoned key does not block its own retry forever');
  });

  it('purges expired keys and leaves live ones alone', async () => {
    const staleKey = `stale-${crypto.randomUUID()}`;
    const liveKey = `live-${crypto.randomUUID()}`;

    await begin({ restaurantId: restaurant.id, userId: null, key: staleKey, hash: hash('stale') });
    await begin({ restaurantId: restaurant.id, userId: null, key: liveKey, hash: hash('live') });
    await db.query(
      'UPDATE idempotency_keys SET expires_at = NOW() - INTERVAL \'1 day\' WHERE restaurant_id = $1 AND key = $2',
      [restaurant.id, staleKey]
    );

    const purged = await purgeExpired();
    assert.ok(purged >= 1, 'the stale key was removed');

    const { rows } = await db.query(
      'SELECT key FROM idempotency_keys WHERE restaurant_id = $1 AND key = ANY($2)',
      [restaurant.id, [staleKey, liveKey]]
    );
    assert.deepEqual(rows.map(r => r.key), [liveKey]);
  });
});
