-- A voluntary tip, on the payment that carried it.
--
-- Migration 011 said where this belongs and why, and this only follows through:
-- a tip is untaxed and chosen by the payer rather than by the restaurant, so it
-- is not part of the bill. That is not a stylistic preference -- putting it on
-- the bill breaks three things at once:
--
--   * `CHECK (amount_paid_ves <= total_due_ves)` would reject the tip, because
--     the diner has handed over more than the bill asks for. That constraint is
--     what makes overpayment impossible and must not be relaxed for this.
--   * A bill CLOSES on exact equality with its total. A tip folded into
--     `amount_paid_ves` would close a bill early or never, depending on which
--     side of the total it landed.
--   * `payment_ledger_drift` proves the cached paid figure against the sum of
--     `amount_ves`. A tip inside that sum would read as permanent drift.
--
-- So `amount_ves` stays exactly what it is -- the part of the bill this payment
-- settles -- and the tip sits beside it. What the payer actually handed over is
-- `amount_ves + tip_ves`, and that sum is what a bank is charged and what a till
-- receives. Nothing else in the schema has to know.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS tip_ves BIGINT NOT NULL DEFAULT 0;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_tip_non_negative;
ALTER TABLE payments ADD CONSTRAINT payments_tip_non_negative
  CHECK (tip_ves >= 0);

-- Zero rather than null for a payment with no tip, so every report is a plain
-- SUM with no COALESCE and no branch on "was a tip even possible here".

COMMENT ON COLUMN payments.tip_ves IS
  'Voluntary tip in VES centimos, chosen by the payer. NOT part of the bill: '
  'bills.total_due_ves and amount_paid_ves exclude it. Total handed over is '
  'amount_ves + tip_ves.';

-- ---------------------------------------------------------------------------
-- The tip is immutable, like the amount beside it.
--
-- `payments_guard_transition` already refuses to let `amount_ves` or `bill_id`
-- move, on the reasoning that correcting a settled amount is a refund plus a
-- new payment rather than an edit. A tip is money the diner handed over and is
-- owed to staff, so the same rule applies -- and more sharply, because a tip
-- that could be edited after the fact is a tip a restaurant could quietly
-- reduce after the diner has gone.

CREATE OR REPLACE FUNCTION payments_guard_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount_ves IS DISTINCT FROM OLD.amount_ves THEN
    RAISE EXCEPTION 'payments.amount_ves is immutable (payment %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.tip_ves IS DISTINCT FROM OLD.tip_ves THEN
    RAISE EXCEPTION 'payments.tip_ves is immutable (payment %)', OLD.id
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
    OR (OLD.status = 'IN_DOUBT'           AND NEW.status IN ('AMBIGUOUS', 'SUCCEEDED', 'FAILED'))
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
-- Reading tips back
--
-- Tips are pooled and handed out at the end of a shift, so the question is
-- always "how much, over this period, and how did it arrive" -- a cash tip is
-- already in the till, an electronic one is money the restaurant owes its staff.
-- Partial, because most payments carry no tip and the index only has to serve
-- the ones that do.

CREATE INDEX IF NOT EXISTS payments_tips_idx
  ON payments (restaurant_id, created_at DESC)
  WHERE tip_ves > 0;
