-- NOT-BACKWARD-COMPATIBLE: Drops the pre-VES bill columns once their values have been carried into the minor-unit ones. Predates the first deployment.
--
-- Code from the previous release cannot run against the schema this leaves, so
-- rolling back past it means restoring a backup rather than redeploying an
-- image. Every migration from 010 onward is additive precisely so that this is
-- not the normal case; see "Migrations" in the README.

-- 008_ves_settlement_columns.sql
--
-- Moves settlement onto explicit VES columns, and freezes the exchange rate
-- when the bill is opened rather than when it is first paid.
--
-- What changes and why:
--
-- 1. bills.currency stops meaning "what we settle in" and starts meaning "what
--    the menu quoted". 003 constrained it to VES because USD and USDT were
--    being applied at face value against a bolívar balance; that was the right
--    fix then, but it also made a USD-priced menu impossible.
--
-- 2. total_due_ves and amount_paid_ves become the authoritative settlement
--    pair. Splite always settles bolívares whatever the menu says, so the
--    amount that matters deserves its own column rather than being inferred.
--
-- 3. The rate is snapshotted at bill creation. Locking it on first payment
--    meant the figure a diner was quoted when the bill was opened could move
--    before anyone paid. Freezing at creation is what makes the quoted total
--    and the settled total the same number.
--
-- 4. amount_paid is dropped rather than kept alongside amount_paid_ves. Two
--    maintained counters for one quantity is exactly the drift the payment
--    ledger was added to eliminate; the menu-currency figure is derived from
--    amount_paid_ves and the bill's frozen rate, which is deterministic.

-- ---------------------------------------------------------------------------
-- 0. Drop the dependent view first
--
-- 007's payment_ledger_drift selects bills.amount_paid, and Postgres refuses to
-- drop a column a view depends on. It is recreated against the settlement
-- columns at the end of this migration.

DROP VIEW IF EXISTS payment_ledger_drift;

-- ---------------------------------------------------------------------------
-- 1. The menu currency

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_currency_check;
ALTER TABLE bills ADD CONSTRAINT bills_currency_check
  CHECK (currency IN ('VES', 'USD', 'EUR'));

COMMENT ON COLUMN bills.currency IS
  'The currency the menu quoted. Settlement is always VES; see total_due_ves.';

-- ---------------------------------------------------------------------------
-- 2. The FX snapshot, taken when the bill is opened

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS fx_rate_ves_per_unit NUMERIC(20,6),
  ADD COLUMN IF NOT EXISTS fx_rate_source VARCHAR(40),
  -- The day BCV's rate applied to, not the moment it was read. BCV publishes
  -- around 16:30 Caracas for the next business day, so these differ.
  ADD COLUMN IF NOT EXISTS fx_value_date DATE,
  ADD COLUMN IF NOT EXISTS fx_rate_as_of TIMESTAMPTZ,
  -- Lets a later change to the calculation rules leave historical bills alone.
  ADD COLUMN IF NOT EXISTS calculation_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_fx_rate_ves_positive;
ALTER TABLE bills ADD CONSTRAINT bills_fx_rate_ves_positive
  CHECK (fx_rate_ves_per_unit IS NULL OR fx_rate_ves_per_unit > 0);

-- A bill not priced in bolívares is unsettleable without a rate.
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_fx_required_for_foreign_currency;
ALTER TABLE bills ADD CONSTRAINT bills_fx_required_for_foreign_currency
  CHECK (currency = 'VES' OR fx_rate_ves_per_unit IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. The settlement pair
--
-- Backfilled from the existing columns. Every bill so far is VES with an
-- implied rate of 1, so the conversion is the identity and nothing is guessed.

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS total_due_ves BIGINT,
  ADD COLUMN IF NOT EXISTS amount_paid_ves BIGINT NOT NULL DEFAULT 0;

UPDATE bills
   SET total_due_ves = total_due,
       amount_paid_ves = amount_paid,
       fx_rate_ves_per_unit = COALESCE(fx_rate_ves_per_unit, 1),
       fx_rate_source = COALESCE(fx_rate_source, fx_source, 'IDENTITY'),
       fx_rate_as_of = COALESCE(fx_rate_as_of, fx_locked_at, created_at)
 WHERE total_due_ves IS NULL;

ALTER TABLE bills ALTER COLUMN total_due_ves SET NOT NULL;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_total_due_ves_check;
ALTER TABLE bills ADD CONSTRAINT bills_total_due_ves_check CHECK (total_due_ves >= 0);

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_amount_paid_ves_check;
ALTER TABLE bills ADD CONSTRAINT bills_amount_paid_ves_check CHECK (amount_paid_ves >= 0);

-- The guarantee from 002, moved onto the column settlement now happens on.
-- This is what makes overpayment impossible regardless of application bugs.
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_amount_paid_ves_within_total;
ALTER TABLE bills ADD CONSTRAINT bills_amount_paid_ves_within_total
  CHECK (amount_paid_ves <= total_due_ves);

-- ---------------------------------------------------------------------------
-- 4. Retire the superseded columns
--
-- amount_paid is dropped, not kept: one settlement counter, not two.
-- fx_rate/fx_source/fx_locked_at described a rate locked on first payment,
-- which the creation-time snapshot replaces.

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_amount_paid_within_total;
ALTER TABLE bills DROP COLUMN IF EXISTS amount_paid;
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_fx_rate_positive;
ALTER TABLE bills DROP COLUMN IF EXISTS fx_rate;
ALTER TABLE bills DROP COLUMN IF EXISTS fx_source;
ALTER TABLE bills DROP COLUMN IF EXISTS fx_locked_at;

COMMENT ON COLUMN bills.total_due_ves IS
  'Authoritative amount to settle, always VES céntimos.';
COMMENT ON COLUMN bills.amount_paid_ves IS
  'Authoritative amount settled so far, always VES céntimos. Cache of the payment ledger.';

-- ---------------------------------------------------------------------------
-- 5. The drift view, recreated against the settlement columns

CREATE VIEW payment_ledger_drift AS
SELECT
  b.id                                   AS bill_id,
  b.restaurant_id,
  b.amount_paid_ves                      AS cached_amount_paid,
  COALESCE(SUM(p.amount_ves), 0)::BIGINT AS ledger_amount_paid,
  b.amount_paid_ves - COALESCE(SUM(p.amount_ves), 0)::BIGINT AS difference
FROM bills b
LEFT JOIN payments p
  ON p.bill_id = b.id
 AND p.status IN ('SUCCEEDED', 'PARTIALLY_REFUNDED')
GROUP BY b.id, b.restaurant_id, b.amount_paid_ves
HAVING b.amount_paid_ves <> COALESCE(SUM(p.amount_ves), 0)::BIGINT;

COMMENT ON VIEW payment_ledger_drift IS
  'Bills whose cached amount_paid_ves disagrees with the payment ledger. Should always be empty.';
