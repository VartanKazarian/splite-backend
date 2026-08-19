-- Proving the split shares agree with the ledger.
--
-- `payment_ledger_drift` (007, recreated in 008) proves `bills.amount_paid_ves`
-- still agrees with the payments behind it. Persistent splits added a second
-- cache of the same kind one level down: `bill_split_participants.amount_paid_ves`
-- is maintained by `advanceShare` in the transaction that settles a payment, and
-- until now nothing could show it had stayed true.
--
-- A cached counter with no way to check it is exactly what the first view exists
-- to avoid, so this is its analogue: a non-empty result is a bug, and belongs in
-- monitoring rather than being discovered during an argument at a till.
--
-- Per participant rather than per split, because that is the granularity the
-- counter is kept at and therefore the granularity a discrepancy has to be read
-- at -- a per-split total could net two opposite errors into looking correct.

CREATE OR REPLACE VIEW bill_split_share_drift AS
SELECT
  sp.id                                  AS participant_id,
  sp.split_id,
  sp.restaurant_id,
  sp.amount_paid_ves                     AS cached_amount_paid,
  COALESCE(SUM(p.amount_ves), 0)::BIGINT AS ledger_amount_paid,
  sp.amount_paid_ves - COALESCE(SUM(p.amount_ves), 0)::BIGINT AS difference
FROM bill_split_participants sp
LEFT JOIN payments p
  ON p.split_participant_id = sp.id
 -- The same statuses payment_ledger_drift counts, for the same reason: these
 -- are the ones whose money is on the bill.
 AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
GROUP BY sp.id, sp.split_id, sp.restaurant_id, sp.amount_paid_ves
HAVING sp.amount_paid_ves <> COALESCE(SUM(p.amount_ves), 0)::BIGINT;

COMMENT ON VIEW bill_split_share_drift IS
  'Split shares whose cached amount_paid_ves disagrees with the payments citing '
  'them. Should always be empty. Note: refunding a share-attributed payment is '
  'not implemented -- when it is, it must decrement the share, and until then '
  'this view is what would catch the omission.';
