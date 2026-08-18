-- Mercantil C2P, and the states a charge can be left in when the bank stops
-- answering.
--
-- C2P is the first rail where Splite initiates a debit rather than being told
-- about one after the fact. That introduces a state the ledger has not needed
-- until now: we asked the bank to move money, and we do not know whether it
-- did. `invoice_number` is not confirmed idempotent by Mercantil, so a charge
-- reported to the diner as "declined" when the debit actually landed invites
-- them to retry and pay twice.
--
-- IN_DOUBT is that state, and AMBIGUOUS is what it becomes when the bank does
-- have a movement for the right amount but nothing ties it to this diner. Both
-- are deliberately *not* settled: `bills.amount_paid_ves` is untouched, exactly
-- as it is for a PENDING Pago Móvil claim, because money we cannot attribute is
-- not money that has arrived.
--
-- No parallel ledger, for the reason 014 gives: a second table of money would
-- be a second answer to "what has this bill been paid", and the two would
-- disagree eventually. A C2P charge is a `payments` row like everything else.
-- `c2p_charges` beside it carries only the correlation fields the resolver
-- needs and no amounts at all.

-- ---------------------------------------------------------------------------
-- 1. The two new states, and the method that produces them

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE payments ADD CONSTRAINT payments_method_check CHECK (payment_method IN (
  'CASH', 'CARD', 'TRANSFER', 'PAGO_MOVIL', 'C2P', 'SPLITE', 'OTHER'
));

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_status_check CHECK (status IN (
  'PENDING', 'IN_DOUBT', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED', 'CANCELLED',
  'REFUNDED', 'PARTIALLY_REFUNDED'
));

-- ---------------------------------------------------------------------------
-- 2. The state machine
--
--   PENDING ──> IN_DOUBT ──> AMBIGUOUS ──> SUCCEEDED ──> PARTIALLY_REFUNDED ──> REFUNDED
--      │           │  │          │  └────> FAILED
--      │           │  └──────────┴───────> SUCCEEDED
--      │           └──────────────────────> FAILED
--      ├──────> AMBIGUOUS
--      ├──────> SUCCEEDED
--      ├──────> FAILED
--      └──────> CANCELLED
--
-- PENDING -> AMBIGUOUS covers a case that has nothing to do with an
-- indeterminate response: the bank *confirmed* the debit, and the bill had
-- closed or been voided while the charge was in flight, so there is money we
-- can account for and cannot apply. It is not SUCCEEDED, because settling it
-- would mean crediting a bill that cannot take it and putting the ledger at
-- odds with `bills.amount_paid_ves`; it is not FAILED, because the diner has
-- been debited. It is a refund somebody has to make, and it belongs in the
-- same queue as a movement we could not attribute.
--
-- Note what is still forbidden: nothing walks back out of SUCCEEDED except a
-- refund, and IN_DOUBT cannot be reached from a settled payment. A resolver
-- that guessed wrong must be corrected with a refund, not by editing the status
-- back to IN_DOUBT and trying again.
--
-- AMBIGUOUS -> AMBIGUOUS is not listed and does not need to be: the trigger
-- returns early when the status is unchanged, so re-running a resolution that
-- stays ambiguous is a no-op rather than an illegal transition.

CREATE OR REPLACE FUNCTION payments_guard_transition() RETURNS TRIGGER AS $$
BEGIN
  -- The settled amount is immutable. Correcting it is a refund plus a new
  -- payment, not an edit.
  IF NEW.amount_ves IS DISTINCT FROM OLD.amount_ves THEN
    RAISE EXCEPTION 'payments.amount_ves is immutable (payment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.bill_id IS DISTINCT FROM OLD.bill_id THEN
    RAISE EXCEPTION 'payments.bill_id is immutable (payment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'PENDING'            AND NEW.status IN ('IN_DOUBT', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED', 'CANCELLED'))
    -- An indeterminate bank response resolves three ways: the movement is
    -- found and attributed, the movement is found but could belong to another
    -- diner, or the settlement window passes with nothing there.
    OR (OLD.status = 'IN_DOUBT'           AND NEW.status IN ('AMBIGUOUS', 'SUCCEEDED', 'FAILED'))
    -- Only a person leaves AMBIGUOUS. The system has already said it cannot
    -- tell, and repeating the query will not make it able to.
    OR (OLD.status = 'AMBIGUOUS'          AND NEW.status IN ('SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'SUCCEEDED'          AND NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
    OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
  ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> % (payment %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 3. What the resolver needs to identify a payer
--
-- One row per C2P charge, keyed by the payment it belongs to. Deliberately
-- narrow: no amount, no status, no bill. Everything that could disagree with
-- `payments` is read from `payments`.
--
-- `payer_phone_last4` is the whole reason this table exists. Matching a bank
-- movement on amount alone settles one table with another table's money, and
-- four digits of the payer's phone is the only discriminator the bank's search
-- response and our record have in common.

CREATE TABLE IF NOT EXISTS c2p_charges (
  payment_id UUID PRIMARY KEY REFERENCES payments(id) ON DELETE RESTRICT,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,

  -- Our correlation id in Mercantil's body. NOT the idempotency key: Mercantil
  -- does not promise to deduplicate on it, so Splite's idempotency stays where
  -- it already is, on payments.idempotency_key.
  invoice_number VARCHAR(80) NOT NULL,

  -- The payer's bank and the last four digits of the phone the clave was issued
  -- against. Four digits is all we keep: it is enough to tell two diners apart
  -- and not enough to be a phone number.
  payer_bank_code VARCHAR(8) NOT NULL,
  payer_phone_last4 CHAR(4) NOT NULL,

  -- When the bank was last asked about this charge, so a queue can show staff
  -- what has already been tried without reading the attempt log.
  last_resolution_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT c2p_charges_phone_last4_check CHECK (payer_phone_last4 ~ '^[0-9]{4}$'),

  -- Same restaurant on both sides, as 016 established for the ledger itself.
  CONSTRAINT c2p_charges_payment_same_restaurant_fk
    FOREIGN KEY (payment_id, restaurant_id) REFERENCES payments (id, restaurant_id)
    ON DELETE RESTRICT,

  -- One invoice number per restaurant. A collision would put two charges under
  -- one correlation id in Mercantil's records, which is what makes a dispute
  -- unanswerable.
  CONSTRAINT c2p_charges_invoice_unique UNIQUE (restaurant_id, invoice_number)
);

-- The queue: charges still waiting on a human or on the settlement window.
CREATE INDEX IF NOT EXISTS c2p_charges_unresolved_idx
  ON c2p_charges (restaurant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Evidence of every resolution attempt
--
-- `payment_transitions` records the moves that happened. Most resolution
-- attempts move nothing -- the movement was ambiguous, or the settlement window
-- has not passed -- and those are exactly the ones somebody will ask about
-- later. audit_logs is unsuitable: its writes are best-effort and swallowed on
-- failure by design, which is the right call for an audit trail and the wrong
-- one for the record of why a diner was told to wait.
--
-- The same reasoning as webhook_deliveries in 014: evidence of what we were
-- told, kept whether or not acting on it succeeded.

CREATE TABLE IF NOT EXISTS c2p_resolution_attempts (
  id BIGSERIAL PRIMARY KEY,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,

  -- MATCHED, AMBIGUOUS, PENDING_WINDOW, NO_MATCH, ALREADY_RESOLVED.
  outcome VARCHAR(24) NOT NULL,

  -- Every bank reference that matched on amount, including the ones rejected
  -- for not identifying the payer. When a restaurant insists the money is
  -- there, this is the list to hand them.
  candidate_refs JSONB NOT NULL DEFAULT '[]',
  reason TEXT,

  -- Null when a scheduled sweep did it rather than a person.
  actor_user_id UUID,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT c2p_resolution_attempts_payment_same_restaurant_fk
    FOREIGN KEY (payment_id, restaurant_id) REFERENCES payments (id, restaurant_id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS c2p_resolution_attempts_payment_idx
  ON c2p_resolution_attempts (payment_id, attempted_at DESC);

-- ---------------------------------------------------------------------------
-- 5. One bank movement settles one payment
--
-- There is no new table for this. `payments_provider_reference_idx` from 007 is
-- already UNIQUE (provider, provider_payment_id), so writing the bank reference
-- there means a second resolution claiming the same movement loses on a unique
-- violation and unwinds its whole settlement transaction. The service turns
-- that 23505 into PAYMENT_REFERENCE_ALREADY_USED.
--
-- Recorded here because the guarantee is easy to miss when reading 019 alone,
-- and because it is the reason this migration does not add the
-- `consumed_bank_references` table the original fix proposed: that table would
-- have been a second, weaker copy of a constraint the ledger already carries.

COMMENT ON TABLE c2p_charges IS
  'Correlation fields for a Mercantil C2P charge. The money lives in payments; '
  'nothing here duplicates it.';
COMMENT ON TABLE c2p_resolution_attempts IS
  'Every attempt to resolve an in-doubt C2P charge, including the ones that '
  'deliberately settled nothing.';
COMMENT ON COLUMN c2p_charges.payer_phone_last4 IS
  'Four digits, the only signal that distinguishes two diners paying identical '
  'amounts at the same time. Matching on amount alone cross-settles tables.';
