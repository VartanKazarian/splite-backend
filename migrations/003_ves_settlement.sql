-- VES is the settlement currency. USD appears only as a display reference,
-- computed from a rate that is locked once, on the first payment against a
-- bill, so every split in a session shows the same figure.

-- 1. Settlement is VES only. USD/USDT were accepted as payment currencies and
--    applied at face value against a VES balance.
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_currency_check;
ALTER TABLE bills ALTER COLUMN currency SET DEFAULT 'VES';
UPDATE bills SET currency = 'VES' WHERE currency <> 'VES';
ALTER TABLE bills ADD CONSTRAINT bills_currency_check CHECK (currency = 'VES');

-- 2. The rate locked for this bill. NULL means no verified rate was available
--    when the first payment landed; the USD reference is then omitted rather
--    than guessed. Settlement is unaffected either way.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(20,6);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS fx_locked_at TIMESTAMPTZ;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS fx_source VARCHAR(40);

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_fx_rate_positive;
ALTER TABLE bills ADD CONSTRAINT bills_fx_rate_positive
  CHECK (fx_rate IS NULL OR fx_rate > 0);

-- 3. Rate history. Doubles as the baseline for the deviation guard, so a
--    restart does not lose the last known good value.
CREATE TABLE IF NOT EXISTS fx_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(40) NOT NULL,
  base VARCHAR(10) NOT NULL DEFAULT 'USD',
  quote VARCHAR(10) NOT NULL DEFAULT 'VES',
  rate NUMERIC(20,6) NOT NULL CHECK (rate > 0),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fx_rates_recent_idx ON fx_rates (base, quote, fetched_at DESC);
