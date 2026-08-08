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

async function persist(rate, source) {
  try {
    await db.query(
      'INSERT INTO fx_rates (source, base, quote, rate) VALUES ($1,$2,$3,$4)',
      [source, 'USD', 'VES', rate]
    );
  } catch (err) {
    console.warn('[FX] Could not persist rate:', err.message);
  }
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
  await persist(rate, source);
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
      cache = await fetchRate();
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

module.exports = { getUsdToVesRate, __reset };
