const { redis } = require('../connectors/redis');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');

/**
 * Fixed-window limiter backed by Redis.
 *
 * failClosed: when Redis is unavailable, reject instead of allowing through.
 * Use it on authentication endpoints, where failing open would silently
 * remove brute-force protection during a cache outage.
 */
function rateLimit({ windowSeconds = 60, max = 60, keyPrefix = 'rl', failClosed = false } = {}) {
  return async (req, res, next) => {
    const identity = req.user?.sub || req.ip || 'unknown';
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
