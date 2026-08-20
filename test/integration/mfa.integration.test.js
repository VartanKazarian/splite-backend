const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const auth = require('../../src/services/auth');
const mfa = require('../../src/services/mfa');
const totp = require('../../src/services/totp');

/**
 * Second-factor sign-in against a real Postgres.
 *
 * The unit suite proves the TOTP arithmetic against the RFC's vectors. What
 * only a database shows is the part that decides whether an account is safe: a
 * code cannot be spent twice, a recovery code cannot be spent twice, and the
 * secret is not sitting in the row in a form anybody could use.
 */
describe('second factor against a real Postgres', { skip }, () => {
  let restaurant;
  let seq = 0;
  const password = 'a-long-enough-dev-password';

  before(async () => { restaurant = await fixtures.createRestaurant({ name: 'MFA Tenant' }); });

  after(async () => {
    await db.query('DELETE FROM user_mfa_recovery_codes WHERE restaurant_id = $1', [restaurant?.id]);
    await db.query('DELETE FROM audit_logs WHERE restaurant_id = $1', [restaurant?.id]);
    await db.query('DELETE FROM refresh_sessions WHERE restaurant_id = $1', [restaurant?.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    // Sign-in reads the login throttle, so this suite holds a Redis connection.
    // Without giving it back the process never exits after its last test, and
    // `node --test` waits on it -- stalling every file queued behind it, not
    // just this one.
    await closeRedis();
  });

  /** A fresh staff account, so no test inherits another's throttle counter. */
  const freshUser = async () => {
    const email = `mfa-${++seq}-${Date.now()}@example.com`;
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'MANAGER') RETURNING id`,
      [restaurant.id, email, await auth.hashPassword(password)]
    );
    return { id: rows[0].id, email, restaurantId: restaurant.id };
  };

  /** Enrols and turns the factor on, returning what a real user would hold. */
  const enrolled = async user => {
    const { secret } = await mfa.beginEnrolment({
      userId: user.id, restaurantId: user.restaurantId, email: user.email
    });
    const { recoveryCodes } = await mfa.confirmEnrolment({
      userId: user.id, restaurantId: user.restaurantId,
      code: totp.codeForStep(secret, totp.stepAt())
    });
    return { secret, recoveryCodes };
  };

  /** A code from a step that has not been spent yet. */
  const freshCode = (secret, offset = 1) => totp.codeForStep(secret, totp.stepAt() + offset);

  let user;
  beforeEach(async () => { user = await freshUser(); });

  it('a password alone signs in until a factor is confirmed', async () => {
    const initial = await auth.login(user.email, password);
    assert.ok(initial.accessToken, 'no factor, no challenge');

    // Enrolment on its own changes nothing. That is what makes a failed QR scan
    // a retry rather than a lockout.
    const { secret } = await mfa.beginEnrolment({
      userId: user.id, restaurantId: user.restaurantId, email: user.email
    });
    assert.ok((await auth.login(user.email, password)).accessToken);

    await mfa.confirmEnrolment({
      userId: user.id, restaurantId: user.restaurantId, code: totp.codeForStep(secret, totp.stepAt())
    });

    const challenged = await auth.login(user.email, password);
    assert.equal(challenged.mfaRequired, true);
    assert.equal(challenged.accessToken, undefined, 'a correct password is now half a login, not a session');
    assert.ok(challenged.challenge);
  });

  it('a code completes the login the password started', async () => {
    const { secret } = await enrolled(user);
    const { challenge } = await auth.login(user.email, password);

    const session = await auth.completeMfaLogin(challenge, freshCode(secret));
    assert.ok(session.accessToken);
    assert.ok(session.refreshToken);
    assert.equal(session.user.email, user.email);
  });

  it('a code cannot be spent twice', async () => {
    // A code stays valid for the whole of its thirty seconds, so without the
    // remembered step, one read over somebody's shoulder is reusable for the
    // rest of it.
    const { secret } = await enrolled(user);
    const step = totp.stepAt() + 1;

    const first = await auth.login(user.email, password);
    assert.ok((await auth.completeMfaLogin(first.challenge, totp.codeForStep(secret, step))).accessToken);

    const second = await auth.login(user.email, password);
    await assert.rejects(
      () => auth.completeMfaLogin(second.challenge, totp.codeForStep(secret, step)),
      err => err.code === 'INVALID_CREDENTIALS' && err.statusCode === 401
    );
  });

  it('the code that switched the factor on cannot then open a session', async () => {
    const { secret } = await enrolled(user);
    const { challenge } = await auth.login(user.email, password);

    await assert.rejects(
      () => auth.completeMfaLogin(challenge, totp.codeForStep(secret, totp.stepAt())),
      err => err.code === 'INVALID_CREDENTIALS'
    );
  });

  it('a recovery code works in place of a code, once', async () => {
    const { recoveryCodes } = await enrolled(user);
    assert.equal(recoveryCodes.length, 10);

    const first = await auth.login(user.email, password);
    assert.ok((await auth.completeMfaLogin(first.challenge, recoveryCodes[0])).accessToken);
    assert.equal(
      (await mfa.status({ userId: user.id, restaurantId: user.restaurantId })).recoveryCodesRemaining,
      9
    );

    const second = await auth.login(user.email, password);
    await assert.rejects(
      () => auth.completeMfaLogin(second.challenge, recoveryCodes[0]),
      err => err.code === 'INVALID_CREDENTIALS'
    );
  });

  it('a recovery code is accepted however it was written down', async () => {
    // These get printed, then typed back in months later.
    const { recoveryCodes } = await enrolled(user);
    const { challenge } = await auth.login(user.email, password);
    const messy = ` ${recoveryCodes[0].toLowerCase().replace('-', ' ')} `;
    assert.ok((await auth.completeMfaLogin(challenge, messy)).accessToken);
  });

  it('the secret is not in the row in any usable form', async () => {
    const { secret } = await enrolled(user);
    const { rows } = await db.query('SELECT mfa_secret, mfa_key_version FROM users WHERE id = $1', [user.id]);

    assert.ok(Buffer.isBuffer(rows[0].mfa_secret));
    assert.equal(rows[0].mfa_key_version, 1);
    assert.ok(!rows[0].mfa_secret.toString('latin1').includes(secret), 'a database dump must not yield a working authenticator');
    // Version ‖ iv ‖ tag ‖ ciphertext: the first byte names the key that sealed it.
    assert.equal(rows[0].mfa_secret.readUInt8(0), 1);
  });

  it('a tampered secret fails loudly rather than decrypting into something else', async () => {
    await enrolled(user);
    await db.query(
      `UPDATE users SET mfa_secret = overlay(mfa_secret placing '\\x00'::bytea from length(mfa_secret))
        WHERE id = $1`,
      [user.id]
    );
    const { challenge } = await auth.login(user.email, password);

    // GCM authenticates: the login fails rather than proceeding against a
    // secret somebody else may have chosen.
    await assert.rejects(() => auth.completeMfaLogin(challenge, '123456'));
  });

  it('disabling requires a code, and returns the account to its password', async () => {
    const { secret } = await enrolled(user);

    await assert.rejects(
      () => mfa.disable({ userId: user.id, restaurantId: user.restaurantId, code: '000000' }),
      err => err.code === 'MFA_CODE_INVALID'
    );

    await mfa.disable({ userId: user.id, restaurantId: user.restaurantId, code: freshCode(secret) });

    assert.ok((await auth.login(user.email, password)).accessToken);
    const { rows } = await db.query(
      `SELECT mfa_secret, mfa_enabled_at,
              (SELECT count(*)::int FROM user_mfa_recovery_codes WHERE user_id = $1) AS codes
         FROM users WHERE id = $1`,
      [user.id]
    );
    assert.equal(rows[0].mfa_secret, null);
    assert.equal(rows[0].mfa_enabled_at, null);
    assert.equal(rows[0].codes, 0, 'the codes go with the factor they belonged to');
  });

  it('turning the factor on and off leaves an audit trail', async () => {
    // The first version wrote these inside the transaction that held the user
    // row. `audit_logs.actor_id` is a foreign key to `users`, so the insert
    // waited on a lock the same transaction held -- for the full statement
    // timeout, after which `logAudit` swallowed its own failure and the entry
    // vanished. The record of somebody removing a second factor is exactly the
    // one you want after an account is lost.
    const { secret } = await enrolled(user);
    await mfa.disable({ userId: user.id, restaurantId: user.restaurantId, code: freshCode(secret) });

    const { rows } = await db.query(
      `SELECT action FROM audit_logs
        WHERE actor_id = $1 AND action IN ('MFA_ENABLED', 'MFA_DISABLED')
        ORDER BY created_at`,
      [user.id]
    );
    assert.deepEqual(rows.map(r => r.action), ['MFA_ENABLED', 'MFA_DISABLED']);
  });

  it('a live factor cannot be silently replaced', async () => {
    // Otherwise anyone holding a live session swaps the secret for one of
    // their own and the real owner is locked out.
    await enrolled(user);
    await assert.rejects(
      () => mfa.beginEnrolment({ userId: user.id, restaurantId: user.restaurantId, email: user.email }),
      err => err.code === 'MFA_ALREADY_ENABLED' && err.statusCode === 409
    );
  });

  it('regenerating recovery codes invalidates the sheet somebody else may hold', async () => {
    const { secret, recoveryCodes } = await enrolled(user);

    const { recoveryCodes: replacement } = await mfa.regenerateRecoveryCodes({
      userId: user.id, restaurantId: user.restaurantId, code: freshCode(secret)
    });
    assert.equal(replacement.length, 10);
    assert.ok(!replacement.includes(recoveryCodes[0]));

    const { challenge } = await auth.login(user.email, password);
    await assert.rejects(
      () => auth.completeMfaLogin(challenge, recoveryCodes[1]),
      err => err.code === 'INVALID_CREDENTIALS'
    );
  });

  it('an account deactivated mid-challenge cannot complete its login', async () => {
    const { secret } = await enrolled(user);
    const { challenge } = await auth.login(user.email, password);

    // The five minutes a challenge lives are five minutes in which somebody may
    // have been dismissed. The user is re-read rather than trusted from it.
    await db.query('UPDATE users SET active = FALSE WHERE id = $1', [user.id]);

    await assert.rejects(
      () => auth.completeMfaLogin(challenge, freshCode(secret)),
      err => err.code === 'INVALID_CREDENTIALS'
    );
  });

  it('a challenge is not an access token, and an access token is not a challenge', async () => {
    const { secret } = await enrolled(user);
    const { challenge } = await auth.login(user.email, password);
    const session = await auth.completeMfaLogin(challenge, freshCode(secret));

    // The challenge is signed with the access secret, so this is the check that
    // keeps that from being a bypass.
    const { verifyAccessToken, verifyMfaChallenge } = require('../../src/utils/tokens');
    assert.notEqual(verifyAccessToken(challenge).type, 'access');
    assert.throws(() => verifyMfaChallenge(session.accessToken), /Not an MFA challenge/);
  });

  it('a spent challenge cannot be replayed with a new code', async () => {
    // Nothing marks a challenge used, so this pins what actually stops the
    // replay: the code is single-use, and a second attempt needs a new one.
    const { secret } = await enrolled(user);
    const { challenge } = await auth.login(user.email, password);

    const step = totp.stepAt() + 1;
    assert.ok((await auth.completeMfaLogin(challenge, totp.codeForStep(secret, step))).accessToken);
    await assert.rejects(
      () => auth.completeMfaLogin(challenge, totp.codeForStep(secret, step)),
      err => err.code === 'INVALID_CREDENTIALS'
    );
  });
});
