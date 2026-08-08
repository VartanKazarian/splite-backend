const config = require('../config');
// Imported as a namespace rather than destructured so the degraded paths
// (stale cache, 503) can be exercised in tests without real network calls.
const resilient = require('../connectors/resilient');

/**
 * Official USD reference rate from the Banco Central de Venezuela.
 *
 * BCV publishes no API. The rate lives in the `id="dolar"` block of the Drupal
 * home page, and the date it applies to sits in the adjacent "Fecha Valor"
 * span, which carries a machine-readable ISO timestamp in Venezuela time.
 *
 * The published rate is a *value date* rate: BCV posts the figure that takes
 * effect on the next business day, so the page can be read at any hour and the
 * date it applies to is what matters, not the moment it was fetched. Callers
 * get that date back so they can decide what to do with it.
 */

// Bounded lookaheads: if BCV restructures the page, these fail to match rather
// than scanning the whole document and picking up an unrelated <strong>.
const RATE_PATTERN = /id="dolar"[\s\S]{0,2000}?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i;
const VALUE_DATE_PATTERN = /Fecha\s+Valor:[\s\S]{0,400}?content="(\d{4}-\d{2}-\d{2})/i;

// A plausibility band. It exists to catch a parse that latched onto the wrong
// element (a "1" from some unrelated markup) rather than to police monetary
// policy, so it is deliberately wide.
const MIN_PLAUSIBLE_RATE = 0.01;
const MAX_PLAUSIBLE_RATE = 1e9;

/**
 * "757,54060000" -> 757.5406 and "1.234,56" -> 1234.56.
 * Venezuelan formatting uses '.' for thousands and ',' for the decimal, which
 * is the exact inverse of what Number() expects.
 */
function parseVenezuelanDecimal(text) {
  const normalised = String(text).trim().replace(/\./g, '').replace(',', '.');
  return Number(normalised);
}

function parseBcvPage(html) {
  const rateMatch = RATE_PATTERN.exec(String(html));
  if (!rateMatch) throw new Error('BCV page did not contain a USD rate in the expected position');

  const rate = parseVenezuelanDecimal(rateMatch[1]);
  if (!Number.isFinite(rate) || rate < MIN_PLAUSIBLE_RATE || rate > MAX_PLAUSIBLE_RATE) {
    throw new Error(`BCV USD rate is not plausible: ${rateMatch[1]}`);
  }

  // The date is informative, not load-bearing: a rate without a parseable
  // value date is still the right number, so this degrades to null.
  const dateMatch = VALUE_DATE_PATTERN.exec(String(html));

  return { rate, valueDate: dateMatch ? dateMatch[1] : null };
}

let cache = null;      // { rate, valueDate, fetchedAt }
let inFlight = null;

function isFresh() {
  if (!cache) return false;
  return Date.now() - cache.fetchedAt < config.exchangeRate.cacheTtlSeconds * 1000;
}

function snapshot(extra) {
  return {
    rate: cache.rate,
    valueDate: cache.valueDate,
    fetchedAt: new Date(cache.fetchedAt).toISOString(),
    source: 'BCV',
    ...extra
  };
}

async function fetchFromBcv() {
  const html = await resilient.resilientGetText(config.exchangeRate.url, {
    timeoutMs: config.exchangeRate.timeoutMs,
    extraCaFile: config.exchangeRate.extraCaFile,
    retries: 3
  });
  const parsed = parseBcvPage(html);
  cache = { ...parsed, fetchedAt: Date.now() };
  return snapshot({ stale: false });
}

/**
 * Returns { rate, valueDate, fetchedAt, source, stale }.
 *
 * Never invents a number. If BCV cannot be reached the last good value is
 * served with stale: true; if there has never been a good value and no
 * explicit EXCHANGE_RATE_FALLBACK is configured, this throws 503 rather than
 * handing back a figure the caller would treat as authoritative.
 */
async function getVesPerUsd({ force = false } = {}) {
  if (!force && isFresh()) return snapshot({ stale: false });

  // Single-flight: a burst of callers on a cold cache makes one request.
  if (inFlight) return inFlight;

  inFlight = fetchFromBcv()
    .catch(error => {
      console.warn('[ExchangeRate] BCV refresh failed:', error.message);

      if (cache) return snapshot({ stale: true, staleReason: error.message });

      if (Number.isFinite(config.exchangeRate.fallbackRate)) {
        return {
          rate: config.exchangeRate.fallbackRate,
          valueDate: null,
          fetchedAt: null,
          source: 'fallback',
          stale: true,
          staleReason: error.message
        };
      }

      const unavailable = new Error('Exchange rate is unavailable');
      unavailable.statusCode = 503;
      throw unavailable;
    })
    .finally(() => { inFlight = null; });

  return inFlight;
}

/** Test seam: drops the module-level cache. */
function resetCache() {
  cache = null;
  inFlight = null;
}

module.exports = { getVesPerUsd, parseBcvPage, parseVenezuelanDecimal, resetCache };
