const { redis } = require('../connectors/redis');
const config = require('../config');
const { ApiError } = require('../errors');
const { hashToken } = require('../utils/tokens');
const { logger } = require('../connectors/logger');

/**
 * Failed logins, counted per account.
 *
 * The limiter on `/api/v1/auth` counts per address, so attempts spread over
 * many addresses against one account are not slowed at all. This closes that,
 * with two caveats about what it is actually for.
 *
 * It is **not** meaningful protection against guessing. Every password here is
 * created with a twelve character minimum, and each attempt costs an Argon2id
 * verify at 19 MiB; a thousand addresses at ten a minute never reaches a
 * twelve-character space. What this buys is cost and visibility:
 *
 *  - Cost. `login()` runs a decoy hash when the account does not exist, so that
 *    response timing cannot be used to enumerate accounts. That means *every*
 *    attempt pays the full 19 MiB, including attempts against addresses that
 *    were never registered, and a distributed caller bypasses the per-address
 *    bound on that work. Checking the counter before the verify cuts it off.
 *  - Visibility. Failures are already audited; a counter is what turns that
 *    from rows in a table nobody reads into something that can raise an alarm.
 *
 * And the thing this must not become is the outage. If hammering an address
 * locks the account behind it, then anyone who knows the owner's email -- it is
 * on the registration form and on their receipts -- can shut a restaurant out
 * of its own till on a Friday night. That is worse than the attack. So: no
 * persistent lock, a short self-healing window, a generous threshold, and the
 * counter cleared the moment a real login succeeds.
 */

/**
 * Counted against the address that was *submitted*, whether or not an account
 * exists for it.
 *
 * That is the whole anti-enumeration property. If only real accounts were
 * counted, then "this address can be throttled and that one cannot" is exactly
 * the oracle the decoy hash in `login()` exists to deny.
 *
 * Hashed because it is somebody's email address and Redis keys surface in logs,
 * dashboards and `KEYS` output.
 */
const keyFor = email => `auth:acct:${hashToken(String(email).trim().toLowerCase())}`;

/**
 * Throws if this account has failed too often lately.
 *
 * Called before the password is verified, which is the point: the work saved is
 * the reason this exists.
 */
async function assertNotThrottled(email) {
  const key = keyFor(email);

  try {
    const [[countErr, count], [ttlErr, ttl]] = await redis.multi().get(key).ttl(key).exec();
    if (countErr) throw countErr;

    if (Number(count) >= config.auth.maxAccountFailures) {
      // RATE_LIMITED, the same code the address limiter uses, so a caller
      // cannot tell which limit they hit -- and therefore cannot use the
      // distinction to learn anything about the account.
      throw new ApiError('RATE_LIMITED', 'Too many failed attempts', {
        retryAfterSeconds: ttlErr || ttl < 0 ? config.auth.accountFailureWindowSeconds : ttl
      });
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;

    logger.warn({ event: 'LOGIN_THROTTLE_UNAVAILABLE', err }, 'Login throttle backend unavailable');
    if (config.rateLimit.failClosedOnAuth) {
      throw new ApiError('RATE_LIMITER_UNAVAILABLE', 'Rate limiter unavailable', {
        retryAfterSeconds: config.auth.accountFailureWindowSeconds
      });
    }
  }
}

/**
 * Records a failure.
 *
 * The expiry is set on every increment rather than only on the first, so the
 * window slides with the attack: a caller pacing themselves just under the
 * threshold does not get a free reset every fifteen minutes.
 */
async function recordFailure(email) {
  const key = keyFor(email);
  try {
    await redis.multi()
      .incr(key)
      .expire(key, config.auth.accountFailureWindowSeconds)
      .exec();
  } catch (err) {
    // Never fail a login attempt because the counter could not be written. The
    // attempt has already been judged on its merits and audited to Postgres.
    logger.warn({ event: 'LOGIN_THROTTLE_WRITE_FAILED', err }, 'Could not record login failure');
  }
}

/** Clears the count. A password that works is proof the attempts were genuine. */
async function clearFailures(email) {
  try {
    await redis.del(keyFor(email));
  } catch (err) {
    logger.warn({ event: 'LOGIN_THROTTLE_CLEAR_FAILED', err }, 'Could not clear login failures');
  }
}

module.exports = { assertNotThrottled, recordFailure, clearFailures, keyFor };
