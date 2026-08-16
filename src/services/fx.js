const db = require('../connectors/base');
const config = require('../config');
// Namespace import so the provider can be stubbed in tests without network.
const bcv = require('../connectors/bcv');
const { logger } = require('../connectors/logger');

/**
 * Official BCV reference rates, in VES per unit of foreign currency.
 *
 * A restaurant may price its menu in USD or EUR rather than hold bolívares
 * through inflation; settlement is still always VES. Two rules follow.
 *
 *  1. Never serve an unverified number. A hardcoded fallback is wrong within a
 *     week here, and a wrong rate is worse than a missing one. There is no
 *     default anywhere.
 *  2. Never block a payment. The rate is frozen when a bill is opened, so an
 *     outage can stop a bill being *opened* in a foreign currency but can never
 *     reach a payment on one that already exists.
 */

const SUPPORTED = ['USD', 'EUR'];

// Per currency, because a rate is only comparable with its own history.
const caches = new Map();     // currency -> { rate, source, valueDate, fetchedAt }
const lastGood = new Map();   // currency -> number, the deviation baseline
let inFlight = null;          // one page fetch serves every currency
let baselineLoaded = false;

function withinAbsoluteBounds(rate) {
  return Number.isFinite(rate) && rate >= config.fx.minRate && rate <= config.fx.maxRate;
}

/**
 * Guards against the scraped page changing shape and yielding a plausible but
 * wrong number — including a figure lifted from the wrong currency's block,
 * which is exactly what a mismatched parse looks like.
 */
function withinDeviationBand(currency, rate) {
  const baseline = lastGood.get(currency);
  if (baseline === undefined) return true;
  return Math.abs(rate - baseline) / baseline * 100 <= config.fx.maxDeviationPct;
}

async function loadBaselines() {
  if (baselineLoaded) return;
  baselineLoaded = true;
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (base) base, rate
         FROM fx_rates
        WHERE quote = 'VES'
        ORDER BY base, value_date DESC`
    );
    for (const row of rows) lastGood.set(row.base, Number(row.rate));
  } catch (err) {
    // A missing table or unreachable database must not break the price display.
    logger.warn({ event: 'FX_BASELINE_UNAVAILABLE', err }, 'Could not load rate baselines');
  }
}

async function persist(currency, rate, source, valueDate) {
  try {
    await db.query(
      `INSERT INTO fx_rates (source, base, quote, rate, value_date)
       VALUES ($1,$2,'VES',$3,$4)
       ON CONFLICT (source, base, quote, value_date)
       DO UPDATE SET rate = EXCLUDED.rate, fetched_at = NOW()`,
      [source, currency, rate, valueDate]
    );
  } catch (err) {
    logger.warn({ event: 'FX_PERSIST_FAILED', currency, valueDate, err }, 'Could not persist rate');
  }
}

/** Today's date in Caracas. Venezuela is UTC-04:00 year round. */
function caracasToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(now);
}

/**
 * Has this publication taken effect yet?
 *
 * A rate with no parseable value date is treated as in force: we hold the
 * number, have nothing better to compare against, and dropping the price
 * display over a formatting change on BCV's page is the worse trade.
 */
function isInForce(valueDate, now = new Date()) {
  if (!valueDate) return true;
  return String(valueDate).slice(0, 10) <= caracasToday(now);
}

/**
 * The last rate we trusted, when BCV cannot be reached.
 *
 * The original code refused outright here, reasoning that serving an old rate
 * as if it were current is the failure this service exists to prevent. That is
 * right for a rate that moves continuously, and wrong for this one: BCV
 * publishes at most once per business day, so between publications the figure
 * in `fx_rates` is not a stale copy of the current rate, it *is* the current
 * rate. Refusing it meant bcv.org.ve being unreachable stopped a restaurant
 * opening any foreign-currency bill -- a third-party website taking the product
 * down while the correct number sat in our own database.
 *
 * Bounded, because the reasoning stops holding once an outage outlives a
 * publication cycle. Past that the figure really is out of date, and in an
 * economy that devalues, quietly pricing bills at a rate from weeks ago is
 * worse than declining to open one. A restaurant told "no rate available" calls
 * somebody; a restaurant undercharging by a third for a fortnight does not
 * notice until it counts the money.
 *
 * The source is marked so the bill records how the rate was obtained. It is
 * snapshotted onto the bill for exactly this kind of question.
 */
async function lastInForce(currency, reason) {
  let historical;
  try {
    historical = await inForceFromHistory(currency);
  } catch (err) {
    logger.error({ event: 'FX_HISTORY_UNAVAILABLE', currency, err }, 'Could not read rate history');
    return null;
  }
  if (!historical) return null;

  const ageDays = Math.floor(
    (Date.parse(`${caracasToday()}T00:00:00Z`) - Date.parse(`${historical.valueDate}T00:00:00Z`))
    / 86400000
  );

  if (ageDays > config.fx.maxFallbackAgeDays) {
    logger.error(
      { event: 'FX_FALLBACK_TOO_OLD', currency, reason, valueDate: historical.valueDate, ageDays },
      'Last known rate is too old to serve; refusing rather than pricing on it'
    );
    return null;
  }

  logger.warn(
    { event: 'FX_SERVED_FROM_HISTORY', currency, reason, valueDate: historical.valueDate, ageDays },
    'Serving the last in-force rate because a fresh one could not be obtained'
  );

  return { ...historical, source: `${historical.source}_LAST_IN_FORCE`.slice(0, 40) };
}

/** The newest rate for a currency whose value date has already arrived. */
async function inForceFromHistory(currency) {
  const { rows } = await db.query(
    `SELECT rate, source, value_date
       FROM fx_rates
      WHERE base = $1 AND quote = 'VES'
        AND value_date <= (NOW() AT TIME ZONE 'America/Caracas')::date
      ORDER BY value_date DESC
      LIMIT 1`,
    [currency]
  );
  if (!rows.length) return null;
  return {
    rate: Number(rows[0].rate),
    source: rows[0].source,
    valueDate: String(rows[0].value_date).slice(0, 10),
    fetchedAt: new Date()
  };
}

/** Fetches every published rate once and validates each independently. */
async function refreshAll() {
  const source = config.fx.source;
  const { rates, valueDate } = await bcv.fetchRates();
  const accepted = {};

  for (const [currency, rate] of Object.entries(rates)) {
    if (!SUPPORTED.includes(currency)) continue;

    if (!withinAbsoluteBounds(rate)) {
      logger.warn({ event: 'FX_OUT_OF_BOUNDS', currency, rate }, 'Rate outside accepted bounds');
      continue;
    }
    if (!withinDeviationBand(currency, rate)) {
      logger.warn(
        { event: 'FX_DEVIATION_REJECTED', currency, rate, baseline: lastGood.get(currency) },
        'Rate deviates too far from the last known good value'
      );
      continue;
    }

    // One currency failing its checks must not discard the others.
    lastGood.set(currency, rate);
    await persist(currency, rate, source, valueDate);
    accepted[currency] = { rate, source, valueDate, fetchedAt: new Date() };
  }

  if (Object.keys(accepted).length === 0) throw new Error('No published rate passed validation');
  return accepted;
}

/**
 * Returns { rate, source, valueDate, fetchedAt } for one currency, or null.
 * Never throws and never guesses.
 */
async function getRateFor(currency) {
  if (currency === 'VES') return { rate: 1, source: 'IDENTITY', valueDate: null, fetchedAt: new Date() };
  if (!config.fx.enabled || !config.fx.url) return null;
  if (!SUPPORTED.includes(currency)) return null;

  const cached = caches.get(currency);
  if (cached && Date.now() - cached.fetchedAt.getTime() < config.fx.ttlMs) return cached;

  // inFlight is assigned with no await before it, or concurrent callers all
  // pass the check above and each fires its own request.
  if (!inFlight) {
    inFlight = (async () => {
      try {
        await loadBaselines();
        const accepted = await refreshAll();
        for (const [code, value] of Object.entries(accepted)) caches.set(code, value);
        return accepted;
      } finally {
        inFlight = null;
      }
    })();
  }

  try {
    await inFlight;
  } catch (err) {
    logger.error({ event: 'FX_UNAVAILABLE', currency, err }, 'Rate unavailable');
    return lastInForce(currency, 'FETCH_FAILED');
  }

  const fresh = caches.get(currency);
  // Reached BCV and still have no usable figure for this currency -- the
  // deviation guard rejects a rate that moved more than it plausibly could,
  // which is exactly the case where the last rate we trusted beats none.
  if (!fresh) return lastInForce(currency, 'REJECTED_BY_GUARD');

  // BCV publishes around 16:30 Caracas for the next business day, so between
  // then and midnight the page shows a rate that does not apply yet.
  if (isInForce(fresh.valueDate)) return fresh;

  try {
    const current = await inForceFromHistory(currency);
    if (current) return current;
  } catch (err) {
    logger.warn({ event: 'FX_HISTORY_UNAVAILABLE', currency, err }, 'Could not read rate history');
  }

  logger.warn(
    { event: 'FX_NOT_YET_IN_FORCE', currency, valueDate: fresh.valueDate },
    'Latest publication is not in force yet and no earlier rate is on record'
  );
  return null;
}

/** Every supported rate currently in force, for the exchange-rate endpoint. */
async function getRates() {
  const entries = await Promise.all(SUPPORTED.map(async c => [c, await getRateFor(c)]));
  return Object.fromEntries(entries.filter(([, value]) => value !== null));
}

/** Retained for callers that only need the USD reference. */
const getUsdToVesRate = () => getRateFor('USD');

/** Test seam. */
function __reset() {
  caches.clear();
  lastGood.clear();
  inFlight = null;
  baselineLoaded = false;
}

module.exports = { getRateFor, getRates, getUsdToVesRate, isInForce, caracasToday, SUPPORTED, __reset };
