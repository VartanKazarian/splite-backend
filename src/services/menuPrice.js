/**
 * Reading a price off a menu.
 *
 * Deliberately separate from `toMinorUnits` in the Mercantil adapter, which
 * solves a similar-looking problem with one decisive difference: a bank
 * sometimes quotes minor units, so a bare `25` there means twenty-five
 * céntimos. A *menu* never does. "25" on a board outside a restaurant is
 * twenty-five bolívares, and reading it as 0,25 would price a dish at a
 * hundredth of its value.
 *
 * That single divergence is why this is its own function rather than a shared
 * one with a flag: the flag would be read wrongly exactly once, and the failure
 * is silent and expensive in both directions.
 *
 * The separator rule is the same one banks need, and is the part that is easy
 * to get wrong:
 *
 *   "1.234,56"  es-VE   dot groups thousands, comma is the decimal
 *   "1,234.56"  en      comma groups thousands, dot is the decimal
 *   "25.00"     either  ambiguous by shape, decided by the digit count
 *
 * A naive strip of every dot turns "25.00" into 2500 and prices a dish a
 * hundred times too high -- which is not hypothetical, it is what a
 * character-class strip of `[Bs.$€\s]` does to the commonest price on a menu.
 */

/** What a menu writes around the number. Stripped, never used to decide scale. */
const CURRENCY_NOISE = /(bs\.?|bss\.?|ves|usd|eur|\$|€|£)/gi;

/**
 * Parses a menu price into minor units, or null if it cannot be read.
 *
 * Null is a result, not a failure: it means "show this row to a human", which
 * is the whole point of the review step. Guessing would put a wrong price on a
 * menu with nobody knowing it had been guessed.
 *
 * @returns {string|null} minor units as a digit string, or null
 */
function parseMenuPrice(raw) {
  if (raw === null || raw === undefined) return null;

  let text = String(raw).trim().replace(CURRENCY_NOISE, '').trim();
  // Everything except digits and the two separators. Catches "12,50 c/u",
  // non-breaking spaces, and stray glyphs the vision model transcribes.
  text = text.replace(/[^\d.,]/g, '');
  if (!text) return null;

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');

  let normalised;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever comes last is the decimal separator, and the
    // other groups thousands. "1.234,56" and "1,234.56" both reach 1234.56.
    normalised = lastComma > lastDot
      ? text.replace(/\./g, '').replace(',', '.')
      : text.replace(/,/g, '');
  } else if (lastComma !== -1) {
    // Only commas. Two digits after the last one is a decimal ("12,50");
    // exactly three is thousands ("1,500" = 1500), which is the reading a
    // Venezuelan menu intends. Anything else is unreadable.
    const tail = text.length - lastComma - 1;
    if (text.indexOf(',') !== lastComma) normalised = text.replace(/,/g, '');
    else if (tail === 3) normalised = text.replace(',', '');
    else if (tail === 1 || tail === 2) normalised = text.replace(',', '.');
    else return null;
  } else if (lastDot !== -1) {
    // Same reasoning for dots: "25.00" is a decimal, "1.500" is thousands.
    const tail = text.length - lastDot - 1;
    if (text.indexOf('.') !== lastDot) normalised = text.replace(/\./g, '');
    else if (tail === 3) normalised = text.replace('.', '');
    else if (tail === 1 || tail === 2) normalised = text;
    else return null;
  } else {
    // Bare digits. A menu quotes whole units, never minor ones.
    normalised = text;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return null;

  const [whole, fraction = ''] = normalised.split('.');
  // BigInt throughout: a menu price is small, but it becomes a bill total that
  // is not, and the rest of this codebase is exact for that reason.
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return minor.toString();
}

module.exports = { parseMenuPrice };
