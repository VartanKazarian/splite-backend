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

async function resolveGuestSession(sessionId, guestToken) {
  if (!sessionId || !guestToken) return null;
  const raw = await redis.get(`${KEY_PREFIX}${sessionId}`);
  if (!raw) return null;

  let session;
  try { session = JSON.parse(raw); } catch { return null; }
  if (!safeEqual(session.tokenHash, hashToken(guestToken))) return null;

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
