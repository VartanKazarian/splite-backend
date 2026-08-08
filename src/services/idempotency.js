const crypto = require('crypto');
const db = require('../connectors/base');

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

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

async function begin({ restaurantId, userId, key, hash }) {
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
  if (!row) return { owner: true };

  if (row.request_hash !== hash) throw conflict('Idempotency key reused with a different request payload');
  if (row.response_status) return { owner: false, response: { status: row.response_status, body: row.response_body } };
  throw conflict('A request with this idempotency key is already in progress');
}

async function complete({ restaurantId, key, status, body }) {
  await db.query(
    'UPDATE idempotency_keys SET response_status = $1, response_body = $2 WHERE restaurant_id = $3 AND key = $4',
    [status, JSON.stringify(body), restaurantId, key]
  );
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
