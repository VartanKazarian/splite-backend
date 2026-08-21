const crypto = require('crypto');
const { ApiError } = require('../errors');
const db = require('../connectors/base');
const { redis } = require('../connectors/redis');
const config = require('../config');
const { hashToken, safeEqual } = require('../utils/tokens');
const { logger } = require('../connectors/logger');

const KEY_PREFIX = 'guest:session:';

/**
 * The session id arrives in a header, so it reaches Postgres as a query
 * parameter typed `uuid`. Anything that is not one raises `invalid input syntax
 * for type uuid`, which would surface as a 500 on a request whose only fault is
 * a malformed header -- and would hand an unauthenticated caller a way to write
 * error lines. Shape is checked before the store is asked.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guest sessions are opaque bearer tokens, stored as their SHA-256 in Postgres
 * and cached in Redis.
 *
 * Only the hash is ever written, in either store, so neither a database dump
 * nor a Redis dump yields a usable credential.
 *
 * The two stores are not a mirror. They hold different facts, and the split is
 * what keeps a sliding session from costing a write per request:
 *
 *   Postgres  who this session is, when it must die whatever happens, and
 *             whether somebody ended it. Durable, and the answer after a flush.
 *   Redis     the idle timer, which slides on every request. Hot, rewritten
 *             constantly, and worth nothing once it is gone.
 *
 * Redis alone used to be the whole record, which made a cache the sole
 * authority on who may pay a bill. A restart, a `FLUSHALL`, or `maxmemory`
 * evicting under pressure signed out every diner in every restaurant at once --
 * and they could not recover, because the client strips the QR token out of the
 * URL once it has been exchanged. Somebody had to get up and rescan the sticker
 * in the middle of paying.
 */

/**
 * A session, written to Postgres first and cached second.
 *
 * Postgres first because it is the record. If the Redis write then fails the
 * session still works -- the next request misses the cache, finds the row, and
 * repopulates it. The reverse order would hand back a token that authenticates
 * only until the cache blinks.
 */
async function createGuestSession({ restaurantId, tableId, ip = null, userAgent = null }) {
  const sessionId = crypto.randomUUID();
  const guestToken = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(guestToken);
  const ttl = config.guest.sessionTtlSeconds;
  const maxAge = config.guest.maxSessionAgeSeconds;
  const agent = userAgent ? String(userAgent).slice(0, 512) : null;

  await db.query(
    `INSERT INTO guest_sessions (id, restaurant_id, table_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'), $6, $7)`,
    [sessionId, restaurantId, tableId, tokenHash, maxAge, agent, ip || null]
  );

  await cache(sessionId, { restaurantId, tableId, tokenHash }, ttl);

  return { sessionId, guestToken, restaurantId, tableId, expiresIn: ttl };
}

/**
 * Writes the cache entry. Never throws: the row is the record, and a cache that
 * cannot be written is a slower next request rather than a failed one.
 */
async function cache(sessionId, session, ttl) {
  try {
    await redis.set(`${KEY_PREFIX}${sessionId}`, JSON.stringify(session), 'EX', ttl);
  } catch (err) {
    logger.warn({ event: 'GUEST_SESSION_CACHE_WRITE_FAILED', sessionId, err },
      'Could not cache a guest session; it still resolves from Postgres');
  }
}

/**
 * Reads a session and, if it is good, pushes its idle expiry back.
 *
 * The TTL used to be set once at creation and never touched, which meant a
 * session died two hours after the QR was scanned no matter what the diner was
 * doing. A dinner runs longer than that easily, so it expired at the one moment
 * it had to work: when they opened the phone to pay.
 *
 * Sliding, not longer, because the right lifetime is "while they are still at
 * the table" and there is no way to know that in advance. Every authenticated
 * request is evidence they are. The absolute cap in Postgres is what keeps
 * sliding from meaning forever -- a tab left open on a phone in a drawer would
 * otherwise never expire at all.
 */
async function resolveGuestSession(sessionId, guestToken) {
  if (!sessionId || !guestToken) return null;
  if (!UUID_SHAPE.test(sessionId)) return null;

  const presented = hashToken(guestToken);
  const cached = await readCache(sessionId);

  if (cached) {
    if (!safeEqual(cached.tokenHash, presented)) return null;
    // The cap is enforced in Postgres, and a cached entry cannot outlive it:
    // the cache TTL is the idle timeout, which is shorter, and the row is
    // re-read the moment the cache misses.
    await slide(sessionId);
    return { sessionId, restaurantId: cached.restaurantId, tableId: cached.tableId };
  }

  // Cache miss, cache flush, or Redis down. The row is the answer.
  const { rows } = await db.query(
    `SELECT id, restaurant_id, table_id, token_hash
       FROM guest_sessions
      WHERE id = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()`,
    [sessionId]
  );
  const row = rows[0];
  if (!row) return null;
  if (!safeEqual(row.token_hash, presented)) return null;

  const session = {
    restaurantId: row.restaurant_id,
    tableId: row.table_id,
    tokenHash: row.token_hash
  };
  // Warm the cache so the outage costs one query per session rather than one
  // per request.
  await cache(sessionId, session, config.guest.sessionTtlSeconds);

  return { sessionId, restaurantId: row.restaurant_id, tableId: row.table_id };
}

/** Null on anything unusable -- a miss, a Redis outage, or a corrupt entry. */
async function readCache(sessionId) {
  let raw;
  try {
    raw = await redis.get(`${KEY_PREFIX}${sessionId}`);
  } catch (err) {
    logger.warn({ event: 'GUEST_SESSION_CACHE_UNAVAILABLE', err },
      'Guest session cache unavailable; falling back to Postgres');
    return null;
  }
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    return session && session.tokenHash ? session : null;
  } catch {
    return null;
  }
}

/**
 * Best effort. Failing a diner's request because the idle expiry could not be
 * pushed back would turn a housekeeping problem into an outage, and the session
 * is still valid for whatever time it had left.
 */
async function slide(sessionId) {
  try {
    await redis.expire(`${KEY_PREFIX}${sessionId}`, config.guest.sessionTtlSeconds);
  } catch { /* keeps its remaining life */ }
}

/**
 * Ends a session.
 *
 * Postgres is stamped rather than the row deleted, and it is stamped even if
 * the cache delete fails: a session somebody deliberately closed must not come
 * back when the cache is flushed and the row is re-read.
 */
async function destroyGuestSession(sessionId) {
  if (!UUID_SHAPE.test(String(sessionId ?? ''))) return;
  await db.query(
    'UPDATE guest_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL',
    [sessionId]
  );
  try {
    await redis.del(`${KEY_PREFIX}${sessionId}`);
  } catch (err) {
    // The cached entry outlives the revocation by at most the idle timeout.
    // Loud, because that window is real.
    logger.warn({ event: 'GUEST_SESSION_CACHE_DELETE_FAILED', sessionId, err },
      'Revoked a guest session but could not clear its cache entry');
  }
}

/** Express middleware: X-Guest-Session + Bearer guest token. */
function authenticateGuest(req, res, next) {
  const sessionId = req.get('x-guest-session');
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token || !sessionId) {
    return next(new ApiError('GUEST_SESSION_MISSING', 'Guest session missing'));
  }
  resolveGuestSession(sessionId, token)
    .then(session => {
      if (!session) return next(new ApiError('GUEST_SESSION_INVALID', 'Invalid or expired guest session'));
      req.guest = session;
      next();
    })
    .catch(next);
}

module.exports = { createGuestSession, resolveGuestSession, destroyGuestSession, authenticateGuest };
