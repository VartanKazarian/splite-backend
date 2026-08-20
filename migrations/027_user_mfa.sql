-- A second factor for staff sign-in.
--
-- Passwords are the only thing standing between a stolen laptop and a
-- restaurant's takings: an OWNER token can read every bill, confirm any
-- declared payment, and change where the money is paid out. Login throttling
-- (migration 012) makes guessing slow; it does nothing about a password that
-- has already leaked somewhere else, which is the ordinary way accounts are
-- lost.
--
-- TOTP rather than email or SMS. Email codes need the mail provider this
-- deployment does not have yet, and SMS in Venezuela is both a cost per login
-- and a dependency on a network that is not always there. A TOTP secret works
-- offline, forever, on a phone the staff member already carries.

ALTER TABLE users
  -- The TOTP secret, sealed with the MFA key ring -- never the raw base32. A
  -- database dump must not hand somebody a working authenticator.
  ADD COLUMN IF NOT EXISTS mfa_secret BYTEA,
  ADD COLUMN IF NOT EXISTS mfa_key_version SMALLINT,

  -- Null until a code has been verified. Enrolment writes a secret and stops;
  -- this column is what makes the factor live, and it is set only after the
  -- user has proved they can produce a code from it. Enabling on generation
  -- would lock out anybody whose authenticator failed to scan the QR.
  ADD COLUMN IF NOT EXISTS mfa_enabled_at TIMESTAMPTZ,

  -- The last TOTP step accepted for this user. A code stays valid for the whole
  -- of its thirty seconds, so without this a code read over somebody's shoulder
  -- can be replayed for the remainder of it.
  ADD COLUMN IF NOT EXISTS mfa_last_step BIGINT;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_mfa_enabled_needs_secret;
ALTER TABLE users ADD CONSTRAINT users_mfa_enabled_needs_secret
  CHECK (mfa_enabled_at IS NULL OR mfa_secret IS NOT NULL);

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_mfa_secret_needs_version;
ALTER TABLE users ADD CONSTRAINT users_mfa_secret_needs_version
  CHECK ((mfa_secret IS NULL) = (mfa_key_version IS NULL));

COMMENT ON COLUMN users.mfa_secret IS
  'Sealed TOTP secret (see src/utils/sealedBox.js). Never returned by any API.';

-- ---------------------------------------------------------------------------
-- Recovery codes
--
-- Not optional, and not a nicety. There is no admin surface in this system --
-- inviting a restaurant is a CLI command run by an operator -- so an OWNER who
-- loses their phone with no recovery code is locked out of their own business
-- with nobody able to let them back in. That is a worse outcome than the
-- account never having had a second factor.
--
-- Hashed, and with SHA-256 rather than Argon2. These are not passwords: they
-- are 80 bits this system generated, so there is no dictionary to run and
-- nothing for a slow hash to buy. What a slow hash would cost is real --
-- verifying one submitted code means testing it against every unused code on
-- the account.
--
-- One row per code rather than an array on `users`, so that spending one is an
-- UPDATE of a single row that a unique index can arbitrate, and so that
-- `used_at` records which was spent and when.

CREATE TABLE IF NOT EXISTS user_mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The same code twice on one account would make "spend exactly once"
  -- ambiguous, and across accounts it would leak that a code was reused.
  CONSTRAINT user_mfa_recovery_codes_unique UNIQUE (user_id, code_hash)
);

-- The lookup on the login path: this user's codes that are still unspent.
CREATE INDEX IF NOT EXISTS user_mfa_recovery_codes_unused_idx
  ON user_mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;
