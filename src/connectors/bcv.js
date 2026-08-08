const config = require('../config');
const { resilientGetText } = require('./resilient');

/**
 * Banco Central de Venezuela — official USD reference rate.
 *
 * A transport and parser only. It fetches, parses and validates *shape*; it
 * holds no cache and applies no business policy. Bounds, deviation limits,
 * persistence and the decision to serve nothing rather than a guess all live in
 * services/fx.js, so there is exactly one place where "is this rate usable?"
 * is answered.
 *
 * BCV publishes no API. The rate sits in the `id="dolar"` block of the Drupal
 * home page and the date it applies to is in the adjacent "Fecha Valor" span,
 * which carries a machine-readable ISO timestamp in Venezuela time.
 */

// Bounded lookaheads: if BCV restructures the page these fail to match rather
// than scanning the whole document and latching onto an unrelated <strong>.
const RATE_PATTERN = /id="dolar"[\s\S]{0,2000}?<strong[^>]*>\s*([\d.,]+)\s*<\/strong>/i;
const VALUE_DATE_PATTERN = /Fecha\s+Valor:[\s\S]{0,400}?content="(\d{4}-\d{2}-\d{2})/i;

/**
 * "757,54060000" -> 757.5406 and "1.234,56" -> 1234.56.
 * Venezuelan formatting uses '.' for thousands and ',' for the decimal, the
 * exact inverse of what Number() expects.
 */
function parseVenezuelanDecimal(text) {
  return Number(String(text).trim().replace(/\./g, '').replace(',', '.'));
}

/** Returns { rate, valueDate } or throws. Performs no plausibility checks. */
function parseBcvPage(html) {
  const rateMatch = RATE_PATTERN.exec(String(html));
  if (!rateMatch) throw new Error('BCV page did not contain a USD rate in the expected position');

  const rate = parseVenezuelanDecimal(rateMatch[1]);
  if (!Number.isFinite(rate)) throw new Error(`BCV USD rate is not a number: ${rateMatch[1]}`);

  // Informative, not load-bearing: a rate without a parseable value date is
  // still the right number.
  const dateMatch = VALUE_DATE_PATTERN.exec(String(html));

  return { rate, valueDate: dateMatch ? dateMatch[1] : null };
}

/**
 * Fetches and parses the live page. Throws on any failure — the caller decides
 * what an unavailable rate means.
 */
async function fetchUsdToVes() {
  const html = await resilientGetText(config.fx.url, {
    timeoutMs: config.fx.timeoutMs,
    extraCaFile: config.fx.extraCaFile,
    retries: 2
  });
  return parseBcvPage(html);
}

module.exports = { fetchUsdToVes, parseBcvPage, parseVenezuelanDecimal };
