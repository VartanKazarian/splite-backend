let cachedRate = 36.50; // Fallback baseline rate
let cacheTimestamp = 0;
const CACHE_TTL_MS = 120000; // 2 minutes

async function getVesToUsdRate() {
    const now = Date.now();
    
    if (cachedRate && (now - cacheTimestamp < CACHE_TTL_MS)) {
        return cachedRate;
    }

    try {
        // Fetch real-time rate from provider
        // const data = await resilientFetch(config.exchangeRateApiUrl);
        // cachedRate = data.rate;
        cacheTimestamp = now;
        return cachedRate;
    } catch (error) {
        console.warn('[ExchangeRate] Failed to refresh rate, using cached value:', error.message);
        return cachedRate;
    }
}

module.exports = { getVesToUsdRate };
