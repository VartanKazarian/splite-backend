const config = require('../config');
const { resilientFetch } = require('../connectors/resilient');

const CACHE_TTL_MS = 120000;
const FALLBACK_RATE = Number(process.env.EXCHANGE_RATE_FALLBACK || 36.5);

let cachedRate = FALLBACK_RATE;
let cacheTimestamp = 0;
let inFlight = null;

function isValidRate(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * VES per USD, cached for two minutes.
 *
 * Concurrent callers share a single upstream request (inFlight), and a failed
 * refresh degrades to the last known good rate rather than throwing.
 */
async function getVesToUsdRate() {
  const now = Date.now();
  if (now - cacheTimestamp < CACHE_TTL_MS) return cachedRate;
  if (inFlight) return inFlight;

  if (!config.exchangeRateApiUrl) {
    cacheTimestamp = now;
    return cachedRate;
  }

  inFlight = (async () => {
    try {
      const data = await resilientFetch(config.exchangeRateApiUrl);
      const rate = Number(data?.rate);
      if (!isValidRate(rate)) throw new Error('Upstream returned an invalid rate');
      cachedRate = rate;
      cacheTimestamp = Date.now();
      return cachedRate;
    } catch (error) {
      console.warn('[ExchangeRate] Refresh failed, serving cached value:', error.message);
      return cachedRate;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

module.exports = { getVesToUsdRate };
