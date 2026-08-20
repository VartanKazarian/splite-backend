const crypto = require('crypto');
const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { createSealedBox } = require('../utils/sealedBox');
const { hashToken } = require('../utils/tokens');
const totp = require('./totp');
const { logAudit } = require('./audit');

/**
 * Second-factor enrolment and verification.
 *
 * The shape of the thing: enrolling writes a sealed secret and nothing else,
 * confirming a code from that secret is what turns the factor on, and from then
 * on a correct password is no longer a session -- it is a challenge that a code
 * completes. Recovery codes are the way back for somebody whose phone is gone,
 * and they exist because this system has no admin surface to let anybody back
 * in by hand.
 */

const box = createSealedBox({
  envName: 'MFA_SECRET_KEYS',
  readKeys: () => config.mfa.secretKeys,
  readActiveVersion: () => config.mfa.activeKeyVersion,
  missing: () => new ApiError(
    'MFA_KEY_MISSING',
    'MFA_SECRET_KEYS is not configured, so second factors cannot be enrolled or verified'
  ),
  unreadable: reason => new ApiError('MFA_SECRET_UNREADABLE', `The stored second factor ${reason}`)
});

/**
 * A recovery code: 10 bytes of randomness, printed as two base32 groups.
 *
 * Grouped and upper-cased because these get written on paper and typed back in
 * months later. 80 bits is far past anything guessable, which is what lets the
 * hash below be a fast one.
 */
function generateRecoveryCode() {
  const raw = totp.base32Encode(crypto.randomBytes(10));
  return `${raw.slice(0, 8)}-${raw.slice(8, 16)}`;
}

/** Codes are compared in one spelling: no dashes, no case, no spaces. */
const normaliseRecoveryCode = value =>
  String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

async function issueRecoveryCodes(client, { userId, restaurantId }) {
  const codes = Array.from({ length: config.mfa.recoveryCodeCount }, generateRecoveryCode);

  // Replacing the set, not adding to it: re-enrolling must invalidate the codes
  // printed for the old secret, or a sheet of paper from a phone the user no
  // longer has still opens the account.
  await client.query('DELETE FROM user_mfa_recovery_codes WHERE user_id = $1', [userId]);
  for (const code of codes) {
    await client.query(
      `INSERT INTO user_mfa_recovery_codes (user_id, restaurant_id, code_hash)
       VALUES ($1, $2, $3)`,
      [userId, restaurantId, hashToken(normaliseRecoveryCode(code))]
    );
  }
  return codes;
}

/**
 * Audit, strictly after the transaction has committed.
 *
 * Never inside one that holds this user's row. `audit_logs.actor_id` is a
 * foreign key to `users`, so writing the row needs a shared lock on the very
 * row a `SELECT ... FOR UPDATE` here is holding exclusively -- and `logAudit`
 * runs on its own pooled connection, so it waits for a transaction that is
 * itself waiting for it. The first version of this file did exactly that: every
 * call sat for the full statement timeout, and since `logAudit` swallows its
 * own failures, the audit entry was then lost without a sound. The record of
 * somebody turning a second factor off is not a thing to lose quietly.
 */
function auditAfterCommit({ restaurantId, userId, action, meta }) {
  return logAudit({
    restaurantId, actorId: userId, action, resourceType: 'user', resourceId: userId, ...meta
  });
}

/**
 * Step one: mint a secret and hand back what an authenticator needs.
 *
 * Deliberately does not enable anything. The secret is stored so that the
 * confirmation can be checked against the same one the QR carried, and until a
 * code arrives the account still signs in on its password alone -- which is
 * what makes a failed scan a retry rather than a lockout.
 */
async function beginEnrolment({ userId, restaurantId, email }) {
  const secret = totp.generateSecret();
  const { blob, keyVersion } = box.seal(secret);

  const { rowCount } = await db.query(
    `UPDATE users
        SET mfa_secret = $1, mfa_key_version = $2, mfa_enabled_at = NULL,
            mfa_last_step = NULL, updated_at = NOW()
      WHERE id = $3 AND restaurant_id = $4 AND mfa_enabled_at IS NULL`,
    [blob, keyVersion, userId, restaurantId]
  );

  // Re-enrolling while a factor is live would let anyone holding a live session
  // swap the secret for one of their own. Turning it off first is a step that
  // costs a code.
  if (!rowCount) {
    throw new ApiError('MFA_ALREADY_ENABLED', 'Disable the current second factor before enrolling another');
  }

  return { secret, otpauthUri: totp.otpauthUri({ secret, account: email }) };
}

/** Step two: a code proves the authenticator holds the same secret. */
async function confirmEnrolment({ userId, restaurantId, code, meta = {} }) {
  const result = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, mfa_secret, mfa_enabled_at FROM users
        WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [userId, restaurantId]
    );
    const user = rows[0];
    if (!user || !user.mfa_secret) {
      throw new ApiError('MFA_NOT_ENROLLED', 'Start enrolment before confirming a code');
    }
    if (user.mfa_enabled_at) {
      throw new ApiError('MFA_ALREADY_ENABLED', 'This account already has a second factor');
    }

    const match = totp.verify(box.open(user.mfa_secret), code);
    if (!match) throw new ApiError('MFA_CODE_INVALID', 'That code is not valid');

    await client.query(
      `UPDATE users SET mfa_enabled_at = NOW(), mfa_last_step = $1, updated_at = NOW()
        WHERE id = $2 AND restaurant_id = $3`,
      [String(match.step), userId, restaurantId]
    );

    // The only time these are ever readable. They are stored hashed, so a user
    // who loses this response has to regenerate rather than ask for it again.
    return { recoveryCodes: await issueRecoveryCodes(client, { userId, restaurantId }) };
  });

  await auditAfterCommit({ restaurantId, userId, action: 'MFA_ENABLED', meta });
  return result;
}

/**
 * Turning it off, which requires proving you can still turn it on.
 *
 * A live session alone is not enough: a borrowed unlocked laptop would
 * otherwise be able to strip the factor and leave the account on a password the
 * borrower may already have.
 */
async function disable({ userId, restaurantId, code, meta = {} }) {
  const result = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, mfa_secret, mfa_enabled_at, mfa_last_step FROM users
        WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [userId, restaurantId]
    );
    const user = rows[0];
    if (!user?.mfa_enabled_at) {
      throw new ApiError('MFA_NOT_ENABLED', 'This account has no second factor to disable');
    }

    const accepted = await consume(client, { user, code });
    if (!accepted) throw new ApiError('MFA_CODE_INVALID', 'That code is not valid');

    await client.query(
      `UPDATE users
          SET mfa_secret = NULL, mfa_key_version = NULL, mfa_enabled_at = NULL,
              mfa_last_step = NULL, updated_at = NOW()
        WHERE id = $1 AND restaurant_id = $2`,
      [userId, restaurantId]
    );
    await client.query('DELETE FROM user_mfa_recovery_codes WHERE user_id = $1', [userId]);
    return { disabled: true };
  });

  await auditAfterCommit({ restaurantId, userId, action: 'MFA_DISABLED', meta });
  return result;
}

/**
 * Accepts a TOTP code or a recovery code, and spends whichever it was.
 *
 * One function because the caller must not be able to treat them differently:
 * both complete a login, and a response that revealed which kind was submitted
 * would tell an attacker whether they were guessing against six digits or
 * eighty bits. Runs on the caller's transaction, with the user row already
 * locked, so the replay guard and the code spend commit with the login.
 */
async function consume(client, { user, code }) {
  const match = totp.verify(box.open(user.mfa_secret), code, {
    notBeforeStep: user.mfa_last_step === null ? null : Number(user.mfa_last_step)
  });

  if (match) {
    await client.query('UPDATE users SET mfa_last_step = $1 WHERE id = $2', [String(match.step), user.id]);
    return { via: 'TOTP' };
  }

  // Claimed by the UPDATE itself rather than read and then written: two
  // requests carrying the same recovery code cannot both find it unused.
  const { rowCount } = await client.query(
    `UPDATE user_mfa_recovery_codes SET used_at = NOW()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [user.id, hashToken(normaliseRecoveryCode(code))]
  );
  return rowCount ? { via: 'RECOVERY_CODE' } : null;
}

/** What `GET /auth/me` reports, and what a client shows on a settings screen. */
async function status({ userId, restaurantId }) {
  const { rows } = await db.query(
    `SELECT u.mfa_enabled_at,
            (SELECT count(*)::int FROM user_mfa_recovery_codes r
              WHERE r.user_id = u.id AND r.used_at IS NULL) AS recovery_codes_remaining
       FROM users u
      WHERE u.id = $1 AND u.restaurant_id = $2`,
    [userId, restaurantId]
  );
  const row = rows[0];
  if (!row) throw new ApiError('NOT_FOUND', 'User not found');
  return {
    enabled: Boolean(row.mfa_enabled_at),
    enabledAt: row.mfa_enabled_at ? new Date(row.mfa_enabled_at).toISOString() : null,
    recoveryCodesRemaining: row.recovery_codes_remaining
  };
}

/** A fresh sheet, for somebody who has spent theirs. Costs a code. */
async function regenerateRecoveryCodes({ userId, restaurantId, code, meta = {} }) {
  const result = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, mfa_secret, mfa_enabled_at, mfa_last_step FROM users
        WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [userId, restaurantId]
    );
    const user = rows[0];
    if (!user?.mfa_enabled_at) {
      throw new ApiError('MFA_NOT_ENABLED', 'This account has no second factor');
    }
    if (!await consume(client, { user, code })) {
      throw new ApiError('MFA_CODE_INVALID', 'That code is not valid');
    }

    return { recoveryCodes: await issueRecoveryCodes(client, { userId, restaurantId }) };
  });

  await auditAfterCommit({ restaurantId, userId, action: 'MFA_RECOVERY_CODES_REGENERATED', meta });
  return result;
}

module.exports = {
  beginEnrolment, confirmEnrolment, disable, consume, status, regenerateRecoveryCodes,
  generateRecoveryCode, normaliseRecoveryCode, __box: box
};
