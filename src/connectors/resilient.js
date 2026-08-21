const https = require('node:https');
const tls = require('node:tls');
const fs = require('node:fs');

/**
 * Retrying transports for external APIs.
 *
 * Every attempt is bounded by a timeout so a hung upstream cannot pin a
 * request handler open, and 4xx responses (other than 429) are treated as
 * fatal because retrying them cannot help.
 *
 * They are bounded by *size* too. A timeout stops an upstream that has gone
 * quiet; it does nothing about one that keeps talking. Reading a response into
 * memory with no ceiling means a hostile or broken host can take the process
 * down with a body, and the host we actually depend on -- BCV -- is a public
 * page scraped over a chain irregular enough to need its own CA file. The
 * ceiling is generous: it is there to make the failure a rejected response
 * rather than an out-of-memory crash, not to police page weight.
 */

/** Two megabytes of HTML is already ten times the page we parse. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

function isFatalStatus(status) {
  return status >= 400 && status < 500 && status !== 429;
}

/**
 * Accumulates chunks up to a ceiling, in bytes rather than characters.
 *
 * Counting `String.length` after `setEncoding` counts UTF-16 code units, which
 * is not what a byte ceiling means and undercounts every accented character on
 * a Spanish-language page. Buffers are collected instead and decoded once at
 * the end, which also decodes a multi-byte character split across two chunks
 * correctly.
 *
 * Overflow is `fatal`, so `withRetries` does not retry it: a body too large
 * once will be too large again, and three attempts at reading it is three times
 * the memory for the same answer.
 */
function byteCappedCollector(maxBytes, what = 'response') {
  const chunks = [];
  let received = 0;
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > maxBytes) {
        const error = new Error(`${what} exceeded ${maxBytes} bytes`);
        error.fatal = true;
        error.code = 'RESPONSE_TOO_LARGE';
        throw error;
      }
      chunks.push(buf);
    },
    get bytes() { return received; },
    text() { return Buffer.concat(chunks).toString('utf8'); }
  };
}

/**
 * A fetch() response body as text, refusing one that is too big to hold.
 *
 * Exported because the Mercantil adapter reads a bank's response the same way
 * and has the same reason to bound it. `content-length` is checked first where
 * the server sends one, so an oversized body is refused before it is streamed
 * rather than after.
 */
async function readCappedText(response, { maxBytes = MAX_BODY_BYTES, what = 'response' } = {}) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    const error = new Error(`${what} declared ${declared} bytes, over the ${maxBytes} ceiling`);
    error.fatal = true;
    error.code = 'RESPONSE_TOO_LARGE';
    throw error;
  }

  const reader = response.body?.getReader?.();
  // No stream to read: an empty body, or a Response built in a test.
  if (!reader) return response.text();

  const collector = byteCappedCollector(maxBytes, what);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      collector.push(value);
    }
  } catch (err) {
    // Stop the transfer rather than leaving the socket draining a body we have
    // already refused.
    await reader.cancel().catch(() => {});
    throw err;
  }
  return collector.text();
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
 * Uses https.get rather than fetch() because fetch offers no way to supply an
 * additional CA, and the one upstream we depend on (BCV) serves an incomplete
 * certificate chain. See services/exchangeRate.js.
 */
async function resilientGetText(url, {
  retries = 3,
  baseDelayMs = 300,
  timeoutMs = 8000,
  extraCaFile = null,
  maxBytes = MAX_BODY_BYTES,
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

      // No setEncoding: the collector counts bytes, and decoding once at the
      // end handles a multi-byte character split across two chunks.
      const collector = byteCappedCollector(maxBytes, `${url} response`);
      response.on('data', chunk => {
        try {
          collector.push(chunk);
        } catch (err) {
          // Hang up rather than keep receiving a body already refused.
          request.destroy();
          reject(err);
        }
      });
      response.on('end', () => resolve(collector.text()));
      response.on('error', reject);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    request.on('error', reject);
  }), { retries, baseDelayMs });
}

module.exports = { resilientGetText, readCappedText, byteCappedCollector, MAX_BODY_BYTES };
