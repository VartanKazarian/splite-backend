-- Bank API credentials, one set per restaurant per provider.
--
-- Kept apart from the payee columns on `restaurants` for a reason that is not
-- tidiness. Those are readable by design -- some of them by anyone who scans a
-- table QR -- while these are the only values in the system that let something
-- move a restaurant's money. Sharing a table means sharing the access rules,
-- and the first `SELECT *` written by somebody in a hurry publishes a secret
-- key next to a restaurant's name.
--
-- Per restaurant *and* per provider, because a restaurant may bank in more than
-- one place, and because credentials are issued by the bank to the merchant:
-- Mercantil hands over a merchant id, client id, secret key, integrator id and
-- terminal id that belong to that restaurant alone. There is no shared Splite
-- credential to fall back on.
--
-- The credential set itself is an opaque sealed blob rather than columns,
-- because no two banks agree on what a credential is. Mercantil needs five
-- fields; the next bank will need a different number with different names, and
-- a schema that tried to be the union of all of them would be a migration every
-- time a bank is added, plus a row of nulls for every bank that does not use
-- them. What the database needs to know here is which restaurant, which
-- provider, and which key opened it -- not what is inside.

CREATE TABLE IF NOT EXISTS payment_provider_configs (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- MERCANTIL, BANESCO, ... Matches the adapter that will use it.
  provider VARCHAR(40) NOT NULL,

  -- AES-256-GCM, sealed by src/payments/credentials.js as
  -- version ‖ iv ‖ tag ‖ ciphertext. BYTEA rather than text so nothing is
  -- tempted to read it as a string, and so a dump shows bytes rather than
  -- something that looks parseable.
  credentials_encrypted BYTEA NOT NULL,

  -- Duplicated out of the blob's own prefix so a rotation job can find the rows
  -- sealed under an old key with an index rather than by opening every one.
  key_version SMALLINT NOT NULL,

  -- Storing credentials and turning a rail on are different decisions, so this
  -- defaults to false. A restaurant that has pasted its keys in has not thereby
  -- started taking card payments.
  enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- Set when the credentials have actually been exercised against the bank.
  -- Nothing sets it yet -- there is no adapter -- which is exactly why the
  -- CHECK below matters now rather than later.
  credentials_validated_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (restaurant_id, provider)
);

-- A provider cannot be live on credentials nobody has proven.
--
-- The failure this prevents is the quiet one: a restaurant believing it is
-- taking payments, a diner tapping a button, and the first anyone learns of a
-- mistyped merchant id is a bill that will not settle during service. Proving
-- the credentials is a precondition for switching on, not a follow-up task.
ALTER TABLE payment_provider_configs DROP CONSTRAINT IF EXISTS payment_provider_configs_enabled_requires_validation;
ALTER TABLE payment_provider_configs ADD CONSTRAINT payment_provider_configs_enabled_requires_validation
  CHECK (NOT enabled OR credentials_validated_at IS NOT NULL);

-- The rotation query: every row not yet sealed under the current key.
CREATE INDEX IF NOT EXISTS payment_provider_configs_key_version_idx
  ON payment_provider_configs (key_version);

DROP TRIGGER IF EXISTS payment_provider_configs_set_updated_at ON payment_provider_configs;
CREATE TRIGGER payment_provider_configs_set_updated_at
  BEFORE UPDATE ON payment_provider_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE payment_provider_configs IS
  'Bank API credentials, encrypted at rest and never returned by any endpoint. '
  'The DTO for this table exposes booleans and timestamps only; there is no '
  'read path to the plaintext outside the adapter that uses it.';
