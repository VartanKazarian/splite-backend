-- Making the claims queue cheap to watch.
--
-- A declared Pago Movil settles nothing until a member of staff finds it in the
-- bank app, so the queue at `GET /api/v1/payments/claims` is the whole rail's
-- weak point: a diner declares a payment, nobody looks, and the diner leaves
-- believing they have paid. Nothing tells staff a claim arrived -- they poll --
-- which means the fix is a number cheap enough to ask for every few seconds
-- from every till in the room.
--
-- `payments_pending_idx` (migration 007) is on `(created_at) WHERE status =
-- 'PENDING'` with no tenant column, so counting one restaurant's pending claims
-- means walking every PENDING payment in the installation and discarding most of
-- them. That is the wrong shape for the one query that will be asked most often.
--
-- Restaurant first, because that is the equality predicate; `created_at` second,
-- so the oldest claim -- the number that says how long somebody has been waiting
-- -- is the first row of the scan rather than a sort over all of them.

CREATE INDEX IF NOT EXISTS payments_pending_claims_idx
  ON payments (restaurant_id, created_at)
  WHERE status = 'PENDING' AND payment_method = 'PAGO_MOVIL';
