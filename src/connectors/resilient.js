/**
 * Retries an external JSON API with exponential backoff and jitter.
 * Every attempt is bounded by an AbortController so a hung upstream cannot
 * pin a request handler open indefinitely.
 */
async function resilientFetch(url, { retries = 3, baseDelayMs = 300, timeoutMs = 5000 } = {}) {
  let lastError;

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        // 4xx (other than 429) will not succeed on retry.
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(error, { fatal: true });
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries - 1) break;
      const backoff = baseDelayMs * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.25;
      await new Promise(resolve => setTimeout(resolve, backoff + jitter));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError;
}

module.exports = { resilientFetch };
