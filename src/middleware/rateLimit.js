const { redis } = require('../connectors/redis');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');

/**
 * Fixed-window limiter backed by Redis.
 *
 * failClosed: when Redis is unavailable, reject instead of allowing through.
 * Use it on authentication endpoints, where failing open would silently
 * remove brute-force protection during a cache outage.
 *
 * identify: what to count per. The default -- the authenticated user, else the
 * source address -- is the right bucket for almost everything, but not for an
 * endpoint that mails a third party: an attacker spreading requests over many
 * addresses stays under a per-IP limit while every one of those requests lands
 * in the same victim's inbox. Such an endpoint counts per recipient as well,
 * which needs a key taken from the body rather than from the connection.
 *
 * Returning null from identify skips the check, so a limiter keyed on a field
 * that validation has not accepted yet cannot reject the request before the
 * schema gets to explain what was wrong with it.
 */
function rateLimit({
  windowSeconds = 60, max = 60, keyPrefix = 'rl', failClosed = false, identify
} = {}) {
  return async (req, res, next) => {
    // Guest session before IP for the same reason staff subject comes first: a
    // credential identifies a caller, an address identifies a network. Diners
    // are on phones behind carrier NAT, so an entire restaurant -- sometimes a
    // whole neighbourhood -- shares one address, and a per-IP limit meant to
    // stop one abusive client throttles every table in the room at once.
    //
    // This only applies once the credential has been verified, so it is the
    // mounting order that makes it work: a limiter in front of authentication
    // sees no req.guest and silently falls back to IP.
    const identity = identify
      ? identify(req)
      : (req.user?.sub || req.guest?.sessionId || req.ip || 'unknown');
    if (identity == null) return next();
    const key = `${keyPrefix}:${identity}`;
    try {
      // INCR and TTL in one round trip. Reading the TTL back (rather than
      // only setting it when count === 1) self-heals a key that lost its
      // expiry, which would otherwise lock the caller out permanently.
      const [[incrErr, count], [ttlErr, ttl]] = await redis.multi().incr(key).ttl(key).exec();
      if (incrErr) throw incrErr;
      if (ttlErr || ttl < 0) await redis.expire(key, windowSeconds);

      const remaining = Math.max(0, max - count);
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(remaining));

      if (count > max) {
        res.set('Retry-After', String(windowSeconds));
        return next(new ApiError('RATE_LIMITED', 'Too many requests', { retryAfterSeconds: windowSeconds }));
      }
      next();
    } catch (err) {
      logger.warn({ event: 'RATE_LIMIT_BACKEND_UNAVAILABLE', keyPrefix, failClosed, err }, 'Rate limiter backend unavailable');
      if (failClosed) {
        res.set('Retry-After', String(windowSeconds));
        return next(new ApiError('RATE_LIMITER_UNAVAILABLE', 'Rate limiter unavailable', { retryAfterSeconds: windowSeconds }));
      }
      next();
    }
  };
}

module.exports = rateLimit;
