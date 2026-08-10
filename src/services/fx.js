const db = require('../connectors/base');
const config = require('../config');
// Namespace import so the provider can be stubbed in tests without network.
const bcv = require('../connectors/bcv');

/**
 * USD -> VES reference rate.
 *
 * Settlement is always VES, so this rate is presentational: it produces only
 * the "≈ $10.00" line beside the bolívar total. Two rules follow from that.
 *
 *  1. Never serve an unverified number. The bolívar moved 748.78 -> 757.54 in
 *     days during August 2026; a hardcoded fallback is wrong within a week, and
 *     a wrong rate is worse than a missing one. There is no default anywhere.
 *  2. Never block a payment. Unavailable means null, the caller omits the USD
 *     reference, and money still moves.
 */

let cache = null;          // { rate, source, valueDate, fetchedAt }
let lastGood = null;       // deviation baseline, rehydrated from fx_rates
let inFlight = null;
let baselineLoaded = false;

function withinAbsoluteBounds(rate) {
  return Number.isFinite(rate) && rate >= config.fx.minRate && rate <= config.fx.maxRate;
}

/**
 * Guards against the scraped page changing shape and yielding a plausible but
 * wrong number. A genuine devaluation beyond the band needs a human to confirm
 * rather than silently repricing every menu in the country.
 */
function withinDeviationBand(rate) {
  if (lastGood === null) return true;
  const drift = Math.abs(rate - lastGood) / lastGood * 100;
  return drift <= config.fx.maxDeviationPct;
}

async function loadBaseline() {
  if (baselineLoaded) return;
  baselineLoaded = true;
  try {
    const { rows } = await db.query(
      "SELECT rate FROM fx_rates WHERE base='USD' AND quote='VES' ORDER BY fetched_at DESC LIMIT 1"
    );
    if (rows.length) lastGood = Number(rows[0].rate);
  } catch (err) {
    // A missing table or an unreachable database must not break the USD line.
    console.warn('[FX] Could not load rate baseline:', err.message);
  }
}

async function persist(rate, source, valueDate) {
  try {
    // One row per publication: re-reading the same page refreshes it rather
    // than accumulating duplicates that all claim the same value date.
    await db.query(
      `INSERT INTO fx_rates (source, base, quote, rate, value_date)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (source, base, quote, value_date)
       DO UPDATE SET rate = EXCLUDED.rate, fetched_at = NOW()`,
      [source, 'USD', 'VES', rate, valueDate]
    );
  } catch (err) {
    console.warn('[FX] Could not persist rate:', err.message);
  }
}

/** Today's date in Caracas. Venezuela is UTC-04:00 year round. */
function caracasToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
}

/**
 * Has this publication taken effect yet?
 *
 * A rate with no parseable value date is treated as in force: we hold the
 * number and have nothing better to compare against, and refusing it would
 * remove the USD line over a formatting change on BCV's page.
 */
function isInForce(valueDate, now = new Date()) {
  if (!valueDate) return true;
  return String(valueDate).slice(0, 10) <= caracasToday(now);
}

/**
 * The newest rate whose value date has already arrived.
 *
 * Needed between 16:30 Caracas and midnight, when BCV's page already shows
 * tomorrow's rate but today's is still the one in force.
 */
async function inForceFromHistory() {
  const { rows } = await db.query(
    `SELECT rate, source, value_date
       FROM fx_rates
      WHERE base = 'USD' AND quote = 'VES'
        AND value_date <= (NOW() AT TIME ZONE 'America/Caracas')::date
      ORDER BY value_date DESC
      LIMIT 1`
  );
  if (!rows.length) return null;
  return {
    rate: Number(rows[0].rate),
    source: rows[0].source,
    valueDate: String(rows[0].value_date).slice(0, 10),
    fetchedAt: new Date()
  };
}

async function fetchRate() {
  const source = config.fx.source;
  const { rate, valueDate } = await bcv.fetchUsdToVes();

  if (!withinAbsoluteBounds(rate)) {
    throw new Error(`Rate ${rate} outside accepted bounds [${config.fx.minRate}, ${config.fx.maxRate}]`);
  }
  if (!withinDeviationBand(rate)) {
    throw new Error(`Rate ${rate} deviates more than ${config.fx.maxDeviationPct}% from last known good (${lastGood})`);
  }

  lastGood = rate;
  await persist(rate, source, valueDate);
  return { rate, source, valueDate, fetchedAt: new Date() };
}

/**
 * Returns { rate, source, valueDate, fetchedAt } or null.
 * Never throws and never guesses.
 */
async function getUsdToVesRate() {
  if (!config.fx.enabled || !config.fx.url) return null;

  const now = Date.now();
  if (cache && now - cache.fetchedAt.getTime() < config.fx.ttlMs) return cache;
  if (inFlight) return inFlight;

  // inFlight must be assigned with no await between the guard above and here,
  // or concurrent callers all pass the check and each fires its own request.
  inFlight = (async () => {
    try {
      await loadBaseline();
      const published = await fetchRate();

      // BCV publishes around 16:30 Caracas for the next business day, so
      // between then and midnight the page already shows a rate that does not
      // apply yet. Pricing a bill off it would charge tomorrow's rate today.
      if (isInForce(published.valueDate)) {
        cache = published;
        return cache;
      }

      const current = await inForceFromHistory();
      if (!current) {
        // The only rate available is one that has not taken effect. Returning
        // it would be wrong, and inventing one is what this service exists to
        // prevent, so the USD line is omitted until the publication lands.
        console.warn(
          `[FX] Latest publication is for ${published.valueDate}, which is not yet in force, and no earlier rate is on record`
        );
        return null;
      }
      cache = current;
      return cache;
    } catch (err) {
      // Deliberately not falling back to `cache`: serving a stale rate as if it
      // were current is the exact failure mode this service exists to prevent.
      console.error('[FX] Rate unavailable:', err.message);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Test seam. */
function __reset() {
  cache = null;
  lastGood = null;
  inFlight = null;
  baselineLoaded = false;
}

module.exports = { getUsdToVesRate, isInForce, caracasToday, __reset };
