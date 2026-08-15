const crypto = require('crypto');
const { ApiError } = require('../errors');
const argon2 = require('argon2');
const db = require('../connectors/base');
const { redis } = require('../connectors/redis');
const config = require('../config');
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require('../utils/tokens');
const { logAudit } = require('./audit');
const { logger } = require('../connectors/logger');

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

// Verified against this hash when no user matches, so a request for an unknown
// address costs the same as one for a known address. Without it, response time
// is a reliable account-enumeration oracle.
let decoyHashPromise;
function decoyHash() {
  if (!decoyHashPromise) {
    decoyHashPromise = argon2.hash(crypto.randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  }
  return decoyHashPromise;
}

function unauthorized(message = 'Invalid credentials') {
  return new ApiError('INVALID_CREDENTIALS', message);
}

function hashPassword(password) {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/** Issues an access token plus a fresh, persisted refresh session. */
async function issueSession(user, meta = {}, client = db) {
  const info = { id: user.id, restaurantId: user.restaurant_id, role: user.role };
  const jti = crypto.randomUUID();
  const refreshToken = signRefreshToken(info, jti);
  const ttl = config.jwt.refreshTtlSeconds;

  await client.query(
    `INSERT INTO refresh_sessions (id, user_id, restaurant_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4, NOW() + ($5 * INTERVAL '1 second'), $6, $7)`,
    [jti, user.id, user.restaurant_id, hashToken(refreshToken), ttl, meta.userAgent || null, meta.ip || null]
  );

  // Mirror in Redis so revocation takes effect immediately without a DB read
  // on every request. Postgres remains the source of truth.
  try {
    await redis.set(`refresh:${jti}`, '1', 'EX', ttl);
  } catch (err) {
    logger.warn({ event: 'SESSION_MIRROR_FAILED', err }, 'Redis session mirror failed');
  }

  return {
    accessToken: signAccessToken(info),
    refreshToken,
    expiresIn: config.jwt.accessTtl,
    user: { id: user.id, email: user.email, role: user.role, restaurantId: user.restaurant_id }
  };
}

async function login(email, password, meta = {}) {
  // Staff emails are globally unique (migration 002). LIMIT 1 without that
  // constraint would non-deterministically pick a tenant.
  const { rows } = await db.query(
    `SELECT id, restaurant_id, email, password_hash, role, active
       FROM users
      WHERE lower(email) = lower($1)
      LIMIT 1`,
    [email]
  );
  const user = rows[0];

  const passwordOk = user
    ? await argon2.verify(user.password_hash, password).catch(() => false)
    : await argon2.verify(await decoyHash(), password).catch(() => false);

  if (!user || !user.active || !passwordOk) {
    await logAudit({
      action: 'AUTH_LOGIN_FAILED',
      restaurantId: user?.restaurant_id ?? null,
      actorId: user?.id ?? null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
      details: { reason: !user ? 'unknown_user' : !user.active ? 'inactive' : 'bad_password' }
    });
    throw unauthorized();
  }

  const session = await issueSession(user, meta);
  await logAudit({
    action: 'AUTH_LOGIN_SUCCEEDED',
    restaurantId: user.restaurant_id,
    actorId: user.id,
    resourceType: 'user',
    resourceId: user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId
  });
  return session;
}

/**
 * Rotating refresh with reuse detection.
 *
 * The old session is claimed atomically (UPDATE ... WHERE revoked_at IS NULL),
 * so two concurrent requests carrying the same token cannot both succeed.
 * Presenting an already-revoked token is treated as theft: every session for
 * that user is revoked.
 */
/**
 * The current user, for a client restoring a session on boot.
 *
 * This exists so a frontend never has to call /auth/refresh just to find out
 * who it is. Refresh *rotates*: two tabs booting at once both present the same
 * stored token, one claims it, and the other is treated as theft and revokes
 * every session for that user. Using it as a "who am I" call turns a second
 * browser tab into a logout.
 *
 * Read from the database rather than the token, so an account deactivated
 * mid-token stops working inside the access token's fifteen minutes rather than
 * at the end of them.
 */
async function currentUser(userId) {
  const { rows } = await db.query(
    'SELECT id, restaurant_id, email, role, active FROM users WHERE id = $1',
    [userId]
  );
  const user = rows[0];
  if (!user || !user.active) throw unauthorized('User inactive');

  // Deliberately the same shape as `user` in a login or refresh response, so a
  // client stores one type and refreshes it from here.
  return { id: user.id, email: user.email, role: user.role, restaurantId: user.restaurant_id };
}

async function refresh(refreshToken, meta = {}) {
  let claims;
  try {
    claims = verifyRefreshToken(refreshToken);
  } catch {
    throw unauthorized('Invalid refresh token');
  }
  if (claims.type !== 'refresh' || !claims.jti) throw unauthorized('Invalid refresh token');

  const tokenHash = hashToken(refreshToken);

  return db.withTransaction(async client => {
    const claimed = await client.query(
      `UPDATE refresh_sessions
          SET revoked_at = NOW()
        WHERE id = $1
          AND token_hash = $2
          AND revoked_at IS NULL
          AND expires_at > NOW()
      RETURNING user_id, restaurant_id`,
      [claims.jti, tokenHash]
    );

    if (!claimed.rows.length) {
      const known = await client.query(
        'SELECT user_id, restaurant_id, revoked_at FROM refresh_sessions WHERE id = $1 AND token_hash = $2',
        [claims.jti, tokenHash]
      );
      const row = known.rows[0];
      if (row?.revoked_at) {
        await client.query(
          'UPDATE refresh_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
          [row.user_id]
        );
        await logAudit({
          action: 'AUTH_REFRESH_REUSE_DETECTED',
          restaurantId: row.restaurant_id,
          actorId: row.user_id,
          ip: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
          details: { jti: claims.jti }
        });
      }
      throw unauthorized('Refresh session revoked or expired');
    }

    const { rows } = await client.query(
      'SELECT id, restaurant_id, email, role, active FROM users WHERE id = $1',
      [claimed.rows[0].user_id]
    );
    const user = rows[0];
    if (!user || !user.active) throw unauthorized('User inactive');

    try { await redis.del(`refresh:${claims.jti}`); } catch { /* mirror only */ }
    return issueSession(user, meta, client);
  });
}

async function revokeSession(jti) {
  await db.query('UPDATE refresh_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [jti]);
  try { await redis.del(`refresh:${jti}`); } catch { /* mirror only */ }
}

async function revokeAllSessionsForUser(userId) {
  const { rows } = await db.query(
    'UPDATE refresh_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [userId]
  );
  await Promise.allSettled(rows.map(r => redis.del(`refresh:${r.id}`)));
  return rows.length;
}

module.exports = {
  // issueSession is exported for onboarding, which signs the owner in inside
  // the same transaction that creates them -- so the refresh session it writes
  // rolls back with the tenant if anything later in that transaction fails.
  currentUser, login, refresh, revokeSession, revokeAllSessionsForUser, hashPassword, issueSession,
  ARGON2_OPTIONS };
