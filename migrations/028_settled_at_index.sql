-- Reporting a tip in the shift it was verified in.
--
-- `tipsReport` windowed on `payments.created_at`, which for a declared Pago
-- Movil is the moment the *diner* said they had paid -- not the moment a member
-- of staff found the transfer in the bank app and confirmed it. Those are the
-- same instant for a card or a cash sale and can be hours apart for a claim:
-- the queue is worked by a person, and `RECONCILE_UNWORKED_CLAIMS_HOURS` exists
-- precisely because it sometimes is not worked at all.
--
-- So a tip declared at 23:50 and confirmed at 00:30 was reported against the
-- night before, and the tips report is the figure a restaurant hands cash to
-- its staff against. Both shifts are wrong: one is short, the next is over.
--
-- When a payment reached SUCCEEDED is already recorded -- `payment_transitions`
-- is append-only and nothing in the state machine re-enters SUCCEEDED, so there
-- is exactly one such row per payment. What was missing is a way to ask for it
-- by time without walking the table.
--
-- Restaurant and status are the equality predicates and come first; `created_at`
-- last, so a report over one evening is a range scan of that evening rather
-- than a filter over every transition the installation has ever recorded.

CREATE INDEX IF NOT EXISTS payment_transitions_settled_idx
  ON payment_transitions (restaurant_id, to_status, created_at);
