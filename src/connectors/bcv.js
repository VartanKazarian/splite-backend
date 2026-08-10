const config = require('../config');
const { resilientGetText } = require('./resilient');

/**
 * Banco Central de Venezuela — official reference rates.
 *
 * A transport and parser only. It fetches, parses and validates *shape*; it
 * holds no cache and applies no business policy. Bounds, deviation limits,
 * persistence and the decision to serve nothing rather than a guess all live in
 * services/fx.js, so there is exactly one place where "is this rate usable?"
 * is answered.
 *
 * BCV publishes no API. Each currency sits in its own block on the Drupal home
 * page — `id="dolar"`, `id="euro"` and several others we do not price in — and
 * the date they all apply to is in the adjacent "Fecha Valor" span, which
 * carries a machine-readable ISO timestamp in Venezuela time.
 */

/** The blocks we read. Others (yuan, lira, rublo) are published but unused. */
const CURRENCY_BLOCKS = { USD: 'dolar', EUR: 'euro' };

const VALUE_DATE_PATTERN = /Fecha\s+Valor:[\s\S]{0,400}?content="(\d{4}-\d{2}-\d{2})/i;

/**
 * "757,54060000" -> 757.5406 and "1.234,56" -> 1234.56.
 * Venezuelan formatting uses '.' for thousands and ',' for the decimal, the
 * exact inverse of what Number() expects.
 */
function parseVenezuelanDecimal(text) {
  return Number(String(text).trim().replace(/\./g, '').replace(',', '.'));
}

/**
 * Reads one currency block.
 *
 * The lookahead is bounded so a restructured page fails to match rather than
 * scanning on and latching onto the next currency's figure — which would be a
 * plausible-looking number attached to the wrong currency.
 */
function extractRate(html, blockId) {
  const pattern = new RegExp(`id="${blockId}"[\\s\\S]{0,2000}?<strong[^>]*>\\s*([\\d.,]+)\\s*<\\/strong>`, 'i');
  const match = pattern.exec(html);
  if (!match) return null;

  const rate = parseVenezuelanDecimal(match[1]);
  return Number.isFinite(rate) ? rate : null;
}

/**
 * Returns { valueDate, rates: { USD, EUR } }, omitting any currency whose block
 * is missing. Throws only when the page yields nothing usable at all.
 */
function parseBcvPage(html) {
  const text = String(html);
  const rates = {};

  for (const [currency, blockId] of Object.entries(CURRENCY_BLOCKS)) {
    const rate = extractRate(text, blockId);
    if (rate !== null) rates[currency] = rate;
  }

  if (Object.keys(rates).length === 0) {
    throw new Error('BCV page did not contain any rate in the expected position');
  }

  // Informative, not load-bearing: rates without a parseable value date are
  // still the right numbers.
  const dateMatch = VALUE_DATE_PATTERN.exec(text);

  return { rates, valueDate: dateMatch ? dateMatch[1] : null };
}

/**
 * Fetches and parses the live page. Throws on any failure — the caller decides
 * what an unavailable rate means.
 *
 * One request covers every currency, because BCV publishes them all on the same
 * page with the same value date.
 */
async function fetchRates() {
  const html = await resilientGetText(config.fx.url, {
    timeoutMs: config.fx.timeoutMs,
    extraCaFile: config.fx.extraCaFile,
    retries: 2
  });
  return parseBcvPage(html);
}

module.exports = { fetchRates, parseBcvPage, parseVenezuelanDecimal, CURRENCY_BLOCKS };
