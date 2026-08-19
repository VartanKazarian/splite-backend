-- A split stops governing a bill that has changed underneath it.
--
-- Migration 020 froze a split at its basis -- the outstanding balance the moment
-- it was agreed -- which is right: a plan must not move as it is paid. What it
-- did not account for is the bill itself changing afterwards, which in a dining
-- room is ordinary rather than exceptional. The table asks to split, agrees
-- 20.000 between two diners, and then orders another round.
--
-- Before this, the split simply went on claiming 20.000 while the bill became
-- 30.000. Both diners paid their share in full, the ledger stayed perfectly
-- consistent, and the bill sat OPEN with 10.000 owed by nobody -- the diners
-- believing they were square and the table unable to be cleared. No corruption,
-- just a feature that quietly stopped doing its job.
--
-- STALE is the honest answer. It is terminal, like VOID:
--
--   * `bill_splits_one_active_per_bill` is partial on status = 'ACTIVE', so a
--     stale split frees the bill for a fresh one on the new total.
--   * `bill_splits_assert_shares_sum` returns early for a non-ACTIVE split, so
--     the frozen shares are never re-checked against a basis they no longer
--     match.
--   * `advanceShare` refuses any split that is not ACTIVE, so a stale share
--     cannot take new money.
--
-- What deliberately does NOT happen is recomputing the shares. Silently
-- rewriting what a group agreed to is worse than telling them it changed, and
-- a share that has already been paid cannot move anyway. Money already
-- attributed to a stale split stays attributed: it is on the bill's ledger, and
-- `bills.amount_paid_ves` is unaffected by any of this.

ALTER TABLE bill_splits DROP CONSTRAINT IF EXISTS bill_splits_status_check;
ALTER TABLE bill_splits ADD CONSTRAINT bill_splits_status_check
  CHECK (status IN ('ACTIVE', 'STALE', 'VOID'));

-- Reading back the split that last governed a bill, stale or not, is how a
-- client tells "your split went stale, agree another" from "this bill never had
-- one" -- two states that would otherwise both be an empty result.
CREATE INDEX IF NOT EXISTS bill_splits_bill_recent_idx
  ON bill_splits (restaurant_id, bill_id, created_at DESC)
  WHERE status <> 'VOID';

COMMENT ON COLUMN bill_splits.status IS
  'ACTIVE: governs the bill. STALE: the bill total changed after it was agreed, '
  'so it takes no further payments and the group must agree another. VOID: '
  'discarded deliberately, only possible while nothing had been paid into it.';
