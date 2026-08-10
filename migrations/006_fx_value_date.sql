-- 006_fx_value_date.sql
--
-- Records which day a rate applies to, not just when it was fetched.
--
-- BCV publishes the official rate around 16:30 Caracas with a "Fecha Valor" of
-- the next business day. The rate in force right now is therefore the one
-- published the previous day, and after 16:30 the bank's home page is already
-- showing a rate that does not apply yet.
--
-- Storing only fetched_at made those two indistinguishable: a rate scraped at
-- 17:00 looked like the current rate when it was actually tomorrow's. The value
-- date makes the question answerable, and the application selects the newest
-- rate whose value date has already arrived.

ALTER TABLE fx_rates ADD COLUMN IF NOT EXISTS value_date DATE;

-- Existing rows recorded only their fetch time. The Caracas date they were
-- fetched on is the closest available approximation; there were no non-VES
-- bills before this point, so nothing was priced off them.
UPDATE fx_rates
   SET value_date = (fetched_at AT TIME ZONE 'America/Caracas')::date
 WHERE value_date IS NULL;

ALTER TABLE fx_rates ALTER COLUMN value_date SET NOT NULL;

-- One rate per publication. Re-reading the same page must refresh the row
-- rather than pile up duplicates that all claim the same value date.
--
-- Duplicates from before this migration are collapsed first, keeping the most
-- recently fetched row for each value date.
DELETE FROM fx_rates a
 USING fx_rates b
 WHERE a.source = b.source
   AND a.base = b.base
   AND a.quote = b.quote
   AND a.value_date = b.value_date
   AND (a.fetched_at, a.id) < (b.fetched_at, b.id);

CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_publication_idx
  ON fx_rates (source, base, quote, value_date);

-- Supports "the newest rate already in force".
CREATE INDEX IF NOT EXISTS fx_rates_in_force_idx
  ON fx_rates (base, quote, value_date DESC);

COMMENT ON COLUMN fx_rates.value_date IS
  'The day this rate applies to, from BCV Fecha Valor. BCV publishes around 16:30 Caracas for the next business day, so this is normally the day after fetched_at.';
