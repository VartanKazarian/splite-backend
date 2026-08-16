const crypto = require('crypto');
const { ApiError } = require('../errors');
const { redis } = require('../connectors/redis');
const config = require('../config');
const { hashToken, safeEqual } = require('../utils/tokens');

const KEY_PREFIX = 'guest:session:';

/**
 * Guest sessions are opaque bearer tokens held in Redis.
 * Only the SHA-256 of the token is stored, so a dump of Redis does not yield
 * usable credentials.
 */
async function createGuestSession({ restaurantId, tableId, ip = null, userAgent = null }) {
  const sessionId = crypto.randomUUID();
  const guestToken = crypto.randomBytes(32).toString('base64url');
  const ttl = config.guest.sessionTtlSeconds;

  await redis.set(
    `${KEY_PREFIX}${sessionId}`,
    JSON.stringify({
      restaurantId,
      tableId,
      tokenHash: hashToken(guestToken),
      ip,
      userAgent: userAgent ? String(userAgent).slice(0, 512) : null,
      createdAt: new Date().toISOString()
    }),
    'EX',
    ttl
  );

  return { sessionId, guestToken, restaurantId, tableId, expiresIn: ttl };
}

/**
 * Reads a session and, if it is good, pushes its expiry back.
 *
 * The TTL used to be set once at creation and never touched, which meant a
 * session died two hours after the QR was scanned no matter what the diner was
 * doing. A dinner runs longer than that easily, so the session expired at the
 * one moment it had to work: when they opened the phone to pay. And it was
 * unrecoverable in practice, because the client strips the QR token out of the
 * URL after exchanging it and so has nothing left to mint a new session with --
 * the diner has to get up and scan the sticker again.
 *
 * Sliding, not longer, because the right lifetime is "while they are still at
 * the table" and there is no way to know that in advance. Every authenticated
 * request is evidence they are.
 *
 * The absolute cap is what keeps sliding from meaning forever: a session that
 * something keeps touching -- a tab left open on a phone in a drawer, a client
 * polling on a timer -- would otherwise never expire at all.
 */
async function resolveGuestSession(sessionId, guestToken) {
  if (!sessionId || !guestToken) return null;
  const key = `${KEY_PREFIX}${sessionId}`;
  const raw = await redis.get(key);
  if (!raw) return null;

  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!safeEqual(session.tokenHash, hashToken(guestToken))) return null;

  const ageSeconds = (Date.now() - Date.parse(session.createdAt)) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds > config.guest.maxSessionAgeSeconds) {
    // Drop it rather than leave it to expire on its own: it can never be valid
    // again, and a credential that is known dead should not sit in the store.
    await redis.del(key).catch(() => {});
    return null;
  }

  // Best effort. Failing a diner's request because the expiry could not be
  // pushed back would turn a housekeeping problem into an outage, and the
  // session is still valid for whatever time it had left.
  try {
    await redis.expire(key, config.guest.sessionTtlSeconds);
  } catch { /* keeps its remaining life */ }

  return { sessionId, restaurantId: session.restaurantId, tableId: session.tableId };
}

async function destroyGuestSession(sessionId) {
  await redis.del(`${KEY_PREFIX}${sessionId}`);
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
