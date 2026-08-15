-- Declared payments, and evidence of what a provider sent us.
--
-- Two ways a bill gets settled by something other than cash at the till:
--
--   1. A diner pays by Pago Móvil from their own bank app and tells us the
--      reference. Splite never touches that money and no API confirms it, so a
--      human at the restaurant is the verifier. Until they confirm, the money
--      is CLAIMED, not received.
--
--   2. A provider tells us over a webhook. Authoritative, once the signature
--      checks out.
--
-- Both land in `payments`, which already has the state machine, the transition
-- log and the idempotency guarantees. Neither gets its own parallel ledger --
-- a second table of money would be a second answer to "what has this bill been
-- paid", and the two would disagree eventually.

-- What the payer said their bank reference was. Distinct from
-- provider_payment_id, which is an identifier *we were given by a system*; this
-- is a human transcribing digits off a receipt, and it can be wrong.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS declared_reference VARCHAR(32);

COMMENT ON COLUMN payments.declared_reference IS
  'Normalised to digits only. A diner''s transcription of their bank reference, '
  'not proof of anything until somebody verifies it.';

-- One reference settles one bill.
--
-- The attack this closes is cheap and obvious: table A pays 12.600,00 Bs and
-- reads their reference aloud; table B, with an identical total, types the same
-- number. Without this index both claims look equally good to a member of staff
-- glancing at a phone, and confirming both closes two bills against one
-- transfer.
--
-- FAILED and CANCELLED are excluded so a rejected claim releases the reference:
-- the usual reason a claim is rejected is that the diner mistyped it, and they
-- must be able to correct it and try again.
CREATE UNIQUE INDEX IF NOT EXISTS payments_declared_reference_idx
  ON payments (restaurant_id, declared_reference)
  WHERE declared_reference IS NOT NULL AND status NOT IN ('FAILED', 'CANCELLED');

-- Evidence, written before anything is acted on.
--
-- Kept even when processing succeeds. When a restaurant says a payment never
-- arrived, the question is always what the provider actually sent, and an
-- answer reconstructed from our own interpretation of it is not evidence.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  provider VARCHAR(40) NOT NULL,

  -- The provider's own id for the payment. Nullable because an unparseable body
  -- is still worth keeping -- that is precisely the delivery someone will need
  -- to look at.
  provider_payment_id VARCHAR(200),

  -- Set once the delivery has been matched to one of our payments. Null while
  -- it is unattributed, which is a state worth being able to query for.
  payment_id UUID REFERENCES payments(id) ON DELETE SET NULL,

  -- The exact bytes, not a re-serialisation. A JSON round trip reorders keys
  -- and drops whitespace, so a body stored as JSONB can no longer be checked
  -- against the signature that arrived with it.
  raw_body TEXT NOT NULL,
  signature TEXT,

  -- SIGNATURE_INVALID, TIMESTAMP_OUT_OF_TOLERANCE, DUPLICATE, UNPARSEABLE,
  -- PAYMENT_NOT_FOUND, SETTLED. A rejected delivery is recorded too: repeated
  -- signature failures are how a leaked or rotated secret announces itself.
  outcome VARCHAR(32) NOT NULL,
  detail TEXT,

  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_provider_idx
  ON webhook_deliveries (provider, received_at DESC);

CREATE INDEX IF NOT EXISTS webhook_deliveries_payment_idx
  ON webhook_deliveries (payment_id) WHERE payment_id IS NOT NULL;

-- Unattributed deliveries, which is the queue somebody has to work.
CREATE INDEX IF NOT EXISTS webhook_deliveries_unmatched_idx
  ON webhook_deliveries (received_at DESC) WHERE payment_id IS NULL;
