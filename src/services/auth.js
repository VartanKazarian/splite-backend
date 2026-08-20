const crypto = require('crypto');
const { ApiError } = require('../errors');
const argon2 = require('argon2');
const db = require('../connectors/base');
const config = require('../config');
const {
  signAccessToken, signRefreshToken, verifyRefreshToken, hashToken,
  signMfaChallenge, verifyMfaChallenge
} = require('../utils/tokens');
const { logAudit } = require('./audit');
const loginThrottle = require('./loginThrottle');
const mfa = require('./mfa');

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

  // There was a Redis mirror here, `refresh:<jti>`, written on login and
  // deleted on revocation, with a comment claiming it made revocation immediate
  // without a database read. Nothing ever read it, and nothing could usefully
  // have: the access token carries no jti, so it could never serve access-token
  // revocation, and the refresh path has to read Postgres anyway in order to
  // rotate the row. It bought nothing and cost a consistency problem -- the
  // bulk revoke in refresh() did not clear the keys the others did.
  //
  // Removed rather than wired up. A comment that promises a security property
  // the code does not deliver is worse than no comment, because it is the
  // reason nobody looks again.

  return {
    accessToken: signAccessToken(info),
    refreshToken,
    expiresIn: config.jwt.accessTtl,
    user: { id: user.id, email: user.email, role: user.role, restaurantId: user.restaurant_id }
  };
}

async function login(email, password, meta = {}) {
  // Before the lookup and before the verify, because the work this skips is the
  // reason it exists: every attempt otherwise pays a full Argon2id at 19 MiB,
  // including attempts against addresses that were never registered, since
  // `login` hashes a decoy to keep response timing from enumerating accounts.
  await loginThrottle.assertNotThrottled(email);

  // Staff emails are globally unique (migration 002). LIMIT 1 without that
  // constraint would non-deterministically pick a tenant.
  const { rows } = await db.query(
    `SELECT id, restaurant_id, email, password_hash, role, active,
            mfa_secret, mfa_enabled_at, mfa_last_step
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
    // Counted against the submitted address whether or not it exists, or the
    // difference becomes the enumeration oracle the decoy hash above denies.
    await loginThrottle.recordFailure(email);
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

  // A password that works is proof the attempts before it were somebody
  // getting it wrong, not somebody guessing.
  await loginThrottle.clearFailures(email);

  /**
   * With a second factor, a correct password is not a session -- it is half of
   * one. No tokens are issued here, and the challenge carries no role or
   * tenant: it says only which account is mid-login, for the five minutes it
   * takes to read six digits.
   */
  if (user.mfa_enabled_at) {
    await logAudit({
      action: 'AUTH_MFA_CHALLENGED',
      restaurantId: user.restaurant_id,
      actorId: user.id,
      resourceType: 'user',
      resourceId: user.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId
    });
    return {
      mfaRequired: true,
      challenge: signMfaChallenge(user.id),
      expiresIn: config.mfa.challengeTtlSeconds
    };
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
 * The other half of a login: a code against a challenge.
 *
 * Throttled on the account the challenge names, using the same counter the
 * password path uses, because a challenge is a standing invitation to guess six
 * digits and the two limits protect the same account.
 *
 * Every failure here is `INVALID_CREDENTIALS`, the same error the password path
 * gives. Which half failed is not a client's business, and a distinct code
 * would confirm to somebody holding a stolen password that it was the right
 * one.
 */
async function completeMfaLogin(challenge, code, meta = {}) {
  let claims;
  try {
    claims = verifyMfaChallenge(challenge);
  } catch {
    throw unauthorized();
  }

  // Keyed on the user id, so it is a different budget from the password
  // counter (which keys on the submitted address). What matters is that it is
  // per *account* rather than per challenge: asking for a fresh challenge by
  // logging in again does not hand the guesser a new allowance.
  await loginThrottle.assertNotThrottled(claims.sub);

  const session = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, restaurant_id, email, role, active, mfa_secret, mfa_enabled_at, mfa_last_step
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [claims.sub]
    );
    const user = rows[0];
    // Re-read rather than trusted from the challenge: an account deactivated,
    // or a factor removed, in the five minutes since the password must take
    // effect now rather than at the end of them.
    if (!user || !user.active || !user.mfa_enabled_at) return null;

    const accepted = await mfa.consume(client, { user, code });
    if (!accepted) return null;

    // Issued on the same transaction that spent the code, so a refresh session
    // cannot exist for a code that was rolled back.
    return { ...await issueSession(user, meta, client), via: accepted.via };
  });

  if (!session) {
    await loginThrottle.recordFailure(claims.sub);
    await logAudit({
      action: 'AUTH_MFA_FAILED',
      actorId: claims.sub,
      resourceType: 'user',
      resourceId: claims.sub,
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId
    });
    throw unauthorized();
  }

  await loginThrottle.clearFailures(claims.sub);
  const { via, ...issued } = session;
  await logAudit({
    action: 'AUTH_LOGIN_SUCCEEDED',
    restaurantId: issued.user.restaurantId,
    actorId: issued.user.id,
    resourceType: 'user',
    resourceId: issued.user.id,
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    details: { secondFactor: via }
  });
  return issued;
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

    return issueSession(user, meta, client);
  });
}

async function revokeSession(jti) {
  await db.query('UPDATE refresh_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [jti]);
}

async function revokeAllSessionsForUser(userId) {
  const { rows } = await db.query(
    'UPDATE refresh_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [userId]
  );
  return rows.length;
}

module.exports = {
  // issueSession is exported for onboarding, which signs the owner in inside
  // the same transaction that creates them -- so the refresh session it writes
  // rolls back with the tenant if anything later in that transaction fails.
  currentUser, login, completeMfaLogin, refresh, revokeSession, revokeAllSessionsForUser, hashPassword, issueSession,
  ARGON2_OPTIONS };
