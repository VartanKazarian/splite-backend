const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');

/**
 * Retrying transports for external APIs.
 *
 * Every attempt is bounded by a timeout so a hung upstream cannot pin a
 * request handler open, and 4xx responses (other than 429) are treated as
 * fatal because retrying them cannot help.
 */

function isFatalStatus(status) {
  return status >= 400 && status < 500 && status !== 429;
}

async function withRetries(attempt, { retries, baseDelayMs }) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await attempt();
    } catch (error) {
      lastError = error;
      if (error.fatal || i === retries - 1) break;
      const backoff = baseDelayMs * 2 ** i;
      const jitter = Math.random() * backoff * 0.25;
      await new Promise(resolve => setTimeout(resolve, backoff + jitter));
    }
  }
  throw lastError;
}

/** Retries an external JSON API with exponential backoff and jitter. */
async function resilientFetch(url, { retries = 3, baseDelayMs = 300, timeoutMs = 5000 } = {}) {
  return withRetries(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        if (isFatalStatus(response.status)) error.fatal = true;
        throw error;
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }, { retries, baseDelayMs });
}

const caCache = new Map();

/**
 * Builds a CA list of Node's bundled roots plus an extra PEM.
 *
 * Passing `ca` to Node *replaces* the default trust store, so the bundled
 * roots have to be carried over explicitly. This adds a certificate; it never
 * relaxes verification.
 */
function caBundle(extraCaFile) {
  if (!extraCaFile) return undefined;
  if (!caCache.has(extraCaFile)) {
    caCache.set(extraCaFile, [...tls.rootCertificates, fs.readFileSync(extraCaFile, 'utf8')]);
  }
  return caCache.get(extraCaFile);
}

/**
 * HTTPS GET returning the response body as text.
 *
 * Exists separately from resilientFetch because fetch() offers no way to
 * supply an additional CA, and at least one upstream we depend on (BCV) serves
 * an incomplete certificate chain. See services/exchangeRate.js.
 */
async function resilientGetText(url, {
  retries = 3,
  baseDelayMs = 300,
  timeoutMs = 8000,
  extraCaFile = null,
  accept = 'text/html,application/xhtml+xml'
} = {}) {
  const ca = caBundle(extraCaFile);

  return withRetries(() => new Promise((resolve, reject) => {
    const request = https.get(url, { ca, headers: { accept } }, response => {
      const { statusCode } = response;
      if (statusCode !== 200) {
        response.resume();
        const error = new Error(`HTTP ${statusCode}`);
        error.status = statusCode;
        if (isFatalStatus(statusCode)) error.fatal = true;
        return reject(error);
      }
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve(body));
      response.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  }), { retries, baseDelayMs });
}

module.exports = { resilientFetch, resilientGetText };
