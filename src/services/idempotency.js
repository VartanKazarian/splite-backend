const crypto = require('crypto');
const { ApiError } = require('../errors');
const db = require('../connectors/base');
const { logger } = require('../connectors/logger');

/**
 * Idempotency keys for money-moving endpoints.
 *
 * begin()    claims the key, replays a stored response, or rejects a conflict
 * complete() stores the response so retries replay it
 * abort()    releases an unfinished claim so the client can retry
 */

function requestHash(req) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ method: req.method, path: req.path, body: req.body ?? null }))
    .digest('hex');
}



/**
 * How many times `begin` will re-attempt a claim it lost to a vanishing row.
 *
 * One is enough for the race that exists -- the row is already gone by the time
 * we look, so the next INSERT wins outright -- and a bound rather than a loop
 * means a pathological key cannot spin here.
 */
const MAX_CLAIM_ATTEMPTS = 2;

async function begin({ restaurantId, userId, key, hash }, attempt = 1) {
  // Expired claims are cleared first, otherwise an abandoned in-flight key
  // would block the same key forever.
  await db.query(
    'DELETE FROM idempotency_keys WHERE restaurant_id = $1 AND key = $2 AND expires_at <= NOW()',
    [restaurantId, key]
  );

  const inserted = await db.query(
    `INSERT INTO idempotency_keys (restaurant_id, user_id, key, request_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '24 hours')
     ON CONFLICT (restaurant_id, key) DO NOTHING
     RETURNING id`,
    [restaurantId, userId || null, key, hash]
  );
  if (inserted.rows.length) return { owner: true };

  const existing = await db.query(
    'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE restaurant_id = $1 AND key = $2',
    [restaurantId, key]
  );
  const row = existing.rows[0];
  if (!row) {
    // The INSERT conflicted, so a row existed a moment ago -- and by this read
    // it is gone. A failing request's `abort()` racing a client's retry does
    // exactly this, as does the expiry purge.
    //
    // Returning `owner: true` here was the bug: the caller held a claim with
    // nothing behind it, so `complete()` updated no rows, no response was
    // stored, and the *next* retry of the same key found no row either and
    // charged again. The claim is simply re-attempted -- the row is gone, so
    // the INSERT that failed above will now succeed.
    if (attempt >= MAX_CLAIM_ATTEMPTS) {
      throw new ApiError('IDEMPOTENCY_IN_FLIGHT', 'A request with this idempotency key is already in progress');
    }
    return begin({ restaurantId, userId, key, hash }, attempt + 1);
  }

  if (row.request_hash !== hash) {
    throw new ApiError('IDEMPOTENCY_KEY_REUSED', 'Idempotency key reused with a different request payload');
  }
  if (row.response_status) return { owner: false, response: { status: row.response_status, body: row.response_body } };
  throw new ApiError('IDEMPOTENCY_IN_FLIGHT', 'A request with this idempotency key is already in progress');
}

async function complete({ restaurantId, key, status, body }) {
  const { rowCount } = await db.query(
    'UPDATE idempotency_keys SET response_status = $1, response_body = $2 WHERE restaurant_id = $3 AND key = $4',
    [status, JSON.stringify(body), restaurantId, key]
  );

  // Deliberately loud and deliberately not fatal. This runs after the money has
  // moved, and throwing would reach the route's catch, which aborts the key --
  // releasing the client to retry a request that already succeeded. So the
  // failure is reported and the response is still returned; what is lost is the
  // replay, not the payment.
  if (rowCount === 0) {
    logger.error(
      { event: 'IDEMPOTENCY_RESPONSE_NOT_STORED', restaurantId, key },
      'Idempotency key vanished before its response could be stored; a retry will not replay'
    );
  }
}

async function abort({ restaurantId, key }) {
  await db.query(
    'DELETE FROM idempotency_keys WHERE restaurant_id = $1 AND key = $2 AND response_status IS NULL',
    [restaurantId, key]
  );
}

/** Housekeeping for a scheduled job; the table grows unbounded otherwise. */
async function purgeExpired() {
  const { rowCount } = await db.query('DELETE FROM idempotency_keys WHERE expires_at <= NOW()');
  return rowCount;
}

module.exports = { requestHash, begin, complete, abort, purgeExpired };
