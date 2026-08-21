-- NOT-BACKWARD-COMPATIBLE: Widens three rate columns to NUMERIC(20,8). Widening loses nothing, but the type change is not reversible in place. Predates the first deployment.
--
-- Code from the previous release cannot run against the schema this leaves, so
-- rolling back past it means restoring a backup rather than redeploying an
-- image. Every migration from 010 onward is additive precisely so that this is
-- not the normal case; see "Migrations" in the README.

-- 009_fx_rate_precision.sql
--
-- Store rates at the precision BCV publishes them.
--
-- BCV quotes eight decimal places — EUR was 875.21695680 on 10 August 2026 —
-- but these columns were NUMERIC(20,6), inherited from 003 when the only rate
-- in play was a rough USD display reference. Every stored rate was therefore
-- silently rounded: 875.2169568 became 875.216957.
--
-- At today's magnitudes that rounding does not change a converted total, so
-- nothing has been mis-charged. It matters because the rate on a bill is meant
-- to be the rate that was published — that is what makes a bill reconcilable
-- against BCV after the fact, and a figure that is nearly right is exactly the
-- kind of discrepancy that costs hours to explain later.
--
-- Widening is lossless: existing values keep their stored scale and simply gain
-- two more places.

ALTER TABLE fx_rates
  ALTER COLUMN rate TYPE NUMERIC(20,8);

ALTER TABLE bills
  ALTER COLUMN fx_rate_ves_per_unit TYPE NUMERIC(20,8);

-- The rate a foreign-currency tender was converted at, for the same reason.
ALTER TABLE payments
  ALTER COLUMN tendered_fx_rate TYPE NUMERIC(20,8);

COMMENT ON COLUMN bills.fx_rate_ves_per_unit IS
  'VES per one unit of the bill currency, frozen when the bill was opened, at the precision BCV publishes (8 decimal places).';
