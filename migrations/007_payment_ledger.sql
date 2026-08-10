-- 007_payment_ledger.sql
--
-- A durable record of every payment attempt.
--
-- Until now `bills.amount_paid` was the only trace money had moved: a single
-- counter with no record of who paid, when, under which idempotency key, or
-- against which provider reference. That makes reconciliation, refunds and
-- disputes impossible, and leaves a provider webhook with nothing to match an
-- external payment id against.
--
-- `payments` becomes the transaction history. `bills.amount_paid` stays, as a
-- cache maintained in the same transaction as the payment it reflects. It is
-- kept rather than derived on read because CHECK (amount_paid <= total_due)
-- from 002 is what makes overpayment impossible at the database level; a summed
-- read cannot be constrained that way. `payment_ledger_drift` below exists to
-- prove the cache and the ledger agree.

-- ---------------------------------------------------------------------------
-- 1. The ledger

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT, not CASCADE: a payment record must not disappear because a bill
  -- or a restaurant was deleted. Deleting either now requires dealing with the
  -- money first, which is the correct order.
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,

  -- Authoritative settlement amount. Always VES céntimos, always positive:
  -- a refund is a later transition, never a negative payment.
  amount_ves BIGINT NOT NULL CHECK (amount_ves > 0),

  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  payment_method VARCHAR(20) NOT NULL,

  -- Set once an external provider is involved. Null for cash taken at the till.
  provider VARCHAR(40),
  provider_payment_id VARCHAR(200),

  -- The key the caller used, so a payment can be traced back to the request
  -- that created it.
  idempotency_key VARCHAR(128),

  -- Polymorphic by necessity: a payer is either a staff member (users.id) or a
  -- guest session, which lives in Redis and has no table to reference. Deliberately
  -- not a foreign key; payer_type says how to read payer_id.
  payer_type VARCHAR(10) NOT NULL,
  payer_id UUID,

  -- What the diner actually handed over. Venezuelan restaurants routinely take
  -- USD cash against a bolívar bill, and losing that leaves the till
  -- unreconcilable. amount_ves stays authoritative; these record the tender and
  -- the rate used to convert it.
  tendered_amount BIGINT CHECK (tendered_amount IS NULL OR tendered_amount > 0),
  tendered_currency VARCHAR(3),
  tendered_fx_rate NUMERIC(20,6) CHECK (tendered_fx_rate IS NULL OR tendered_fx_rate > 0),

  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payments_status_check CHECK (status IN (
    'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'
  )),
  CONSTRAINT payments_method_check CHECK (payment_method IN (
    'CASH', 'CARD', 'TRANSFER', 'PAGO_MOVIL', 'SPLITE', 'OTHER'
  )),
  CONSTRAINT payments_payer_type_check CHECK (payer_type IN ('STAFF', 'GUEST', 'SYSTEM')),
  CONSTRAINT payments_currency_check CHECK (
    tendered_currency IS NULL OR tendered_currency IN ('VES', 'USD', 'EUR')
  ),
  -- A non-VES tender is meaningless without both the amount and the rate it was
  -- converted at, otherwise the till cannot be reconciled after the fact.
  CONSTRAINT payments_tender_complete CHECK (
    tendered_currency IS NULL
    OR tendered_currency = 'VES'
    OR (tendered_amount IS NOT NULL AND tendered_fx_rate IS NOT NULL)
  ),
  -- A provider reference without a provider cannot be reconciled against
  -- anything.
  CONSTRAINT payments_provider_pair CHECK (
    provider_payment_id IS NULL OR provider IS NOT NULL
  )
);

-- One payment per idempotency key. The idempotency_keys table already replays
-- stored responses, but this is the guarantee that survives a bug in that layer.
CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_idx
  ON payments (restaurant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- A redelivered webhook must not be able to create a second payment for the
-- same external reference.
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_idx
  ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_bill_idx ON payments (restaurant_id, bill_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_restaurant_created_idx ON payments (restaurant_id, created_at DESC);
-- Supports sweeping payments left in flight by an async provider.
CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments (created_at) WHERE status = 'PENDING';

DROP TRIGGER IF EXISTS payments_set_updated_at ON payments;
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Append-only transition history
--
-- `payments.status` is the current state; this is how it got there. Kept
-- separately because a status column is overwritten, and a dispute needs the
-- sequence. audit_logs is deliberately best-effort — its failures are swallowed
-- so they cannot fail a business operation — which makes it unsuitable as the
-- record of money movement.

CREATE TABLE IF NOT EXISTS payment_transitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,

  -- NULL when the payment was created.
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,

  reason VARCHAR(200),
  actor_type VARCHAR(10) NOT NULL DEFAULT 'SYSTEM',
  actor_id UUID,
  -- Ties a transition back to the request and its logs.
  request_id VARCHAR(128),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT payment_transitions_actor_check CHECK (
    actor_type IN ('STAFF', 'GUEST', 'SYSTEM', 'PROVIDER')
  )
);

CREATE INDEX IF NOT EXISTS payment_transitions_payment_idx
  ON payment_transitions (payment_id, created_at);

-- No updated_at trigger and no UPDATE path: rows here are written once.

-- ---------------------------------------------------------------------------
-- 3. The state machine, enforced by the database
--
--   PENDING ──> SUCCEEDED ──> PARTIALLY_REFUNDED ──> REFUNDED
--      ├──────> FAILED
--      └──────> CANCELLED
--
-- FAILED, CANCELLED and REFUNDED are terminal. Enforced here rather than only
-- in the service so a direct UPDATE, a future endpoint or a provider callback
-- cannot walk a payment backwards — for instance flipping a SUCCEEDED payment
-- to FAILED, which would silently unmake money that has already moved.

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
    (OLD.status = 'PENDING'            AND NEW.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED'))
    OR (OLD.status = 'SUCCEEDED'          AND NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
    OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status IN ('PARTIALLY_REFUNDED', 'REFUNDED'))
  ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> % (payment %)', OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_guard_transition ON payments;
CREATE TRIGGER payments_guard_transition BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard_transition();

-- ---------------------------------------------------------------------------
-- 4. Reconciliation
--
-- bills.amount_paid is a cache. This is how to prove it still agrees with the
-- ledger; a non-empty result is a bug, and belongs in monitoring rather than
-- being discovered during a dispute.

CREATE OR REPLACE VIEW payment_ledger_drift AS
SELECT
  b.id                                   AS bill_id,
  b.restaurant_id,
  b.amount_paid                          AS cached_amount_paid,
  COALESCE(SUM(p.amount_ves), 0)::BIGINT AS ledger_amount_paid,
  b.amount_paid - COALESCE(SUM(p.amount_ves), 0)::BIGINT AS difference
FROM bills b
LEFT JOIN payments p
  ON p.bill_id = b.id
 AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
GROUP BY b.id, b.restaurant_id, b.amount_paid
HAVING b.amount_paid <> COALESCE(SUM(p.amount_ves), 0)::BIGINT;

COMMENT ON VIEW payment_ledger_drift IS
  'Bills whose cached amount_paid disagrees with the payment ledger. Should always be empty.';

COMMENT ON TABLE payments IS
  'Immutable-amount record of every payment attempt. bills.amount_paid caches the sum of the settled ones.';
COMMENT ON TABLE payment_transitions IS
  'Append-only history of payment status changes. Written in the same transaction as the change it records.';
