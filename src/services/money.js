/**
 * Exact monetary arithmetic in minor units.
 *
 * Every amount in this codebase is an integer number of minor units held in a
 * BIGINT column, and pg returns those as strings precisely so they survive
 * values beyond 2^53. Doing the arithmetic in `Number` throws that away, and
 * the failure is not theoretical: computing a participant's share as
 * `line_total / quantity * qty` gives 333.3333... for a 1000-céntimo line
 * across three people, and a 10% tip taken from those fractions sums to 99
 * where the tip on the line itself is 100.
 *
 * FX rates are the awkward part, because they are genuinely fractional. The
 * `fx_rate_ves_per_unit` column is NUMERIC(20,8), so a rate is represented here
 * as an integer scaled by 10^8 and parsed from its decimal string form. That
 * keeps the whole pipeline in integers: no binary floating point ever touches a
 * monetary value.
 */

const { ApiError } = require('../errors');

const RATE_SCALE_DECIMALS = 8;
const RATE_SCALE = 10n ** BigInt(RATE_SCALE_DECIMALS);

// PostgreSQL BIGINT bounds. Exceeding these is a failed INSERT rather than a
// silently wrong number, so it is worth catching before the query runs.
const BIGINT_MAX = 9223372036854775807n;
const BIGINT_MIN = -9223372036854775808n;

// 400 means the caller sent an unusable amount; 503 means we could not obtain
// a usable rate, which is not their fault.
function invalid(message, statusCode = 400) {
  return statusCode === 503
    ? new ApiError('FX_UNAVAILABLE', message)
    : new ApiError('INVALID_MONETARY_VALUE', message);
}

/** Accepts a BigInt, an integer Number, or a digit string. */
function toMinor(value, label = 'Monetary value') {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw invalid(`${label} is not an exact integer`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  throw invalid(`${label} is not a valid amount: ${value}`);
}

function assertInRange(value, label) {
  if (value > BIGINT_MAX || value < BIGINT_MIN) {
    throw invalid(`${label} exceeds the supported monetary range`);
  }
  return value;
}

/**
 * Parses a rate into an integer scaled by 10^8, without going through a float.
 * "757.5406" -> 75754060000n
 */
function parseRate(value, label = 'FX rate') {
  if (typeof value === 'bigint') return value * RATE_SCALE;

  const text = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw invalid(`${label} is not a valid rate: ${value}`, 503);

  const [whole, fraction = ''] = text.split('.');
  // Truncating rather than rounding: NUMERIC(20,8) is the column's own
  // precision, so anything beyond it was never storable in the first place.
  const padded = (fraction + '0'.repeat(RATE_SCALE_DECIMALS)).slice(0, RATE_SCALE_DECIMALS);
  const scaled = BigInt(whole) * RATE_SCALE + BigInt(padded);

  if (scaled <= 0n) throw invalid(`${label} must be positive`, 503);
  return scaled;
}

/** Rounds a non-negative rational to the nearest integer, halves away from zero. */
function divideRound(numerator, denominator) {
  if (denominator <= 0n) throw invalid('Division by a non-positive denominator');
  if (numerator >= 0n) return (numerator + denominator / 2n) / denominator;
  return -((-numerator + denominator / 2n) / denominator);
}

/** minor units -> VES minor units, at a rate scaled by 10^8. */
function applyRate(minorUnits, scaledRate, label = 'Converted amount') {
  const result = divideRound(toMinor(minorUnits) * scaledRate, RATE_SCALE);
  return assertInRange(result, label);
}

/** VES minor units -> menu-currency minor units. The inverse of applyRate. */
function divideByRate(vesMinorUnits, scaledRate, label = 'Display amount') {
  const result = divideRound(toMinor(vesMinorUnits) * RATE_SCALE, scaledRate);
  return assertInRange(result, label);
}

/** Applies a basis-point rate: 1600 bps = 16%. */
function applyBps(minorUnits, rateBps, label = 'Charge') {
  const bps = toMinor(rateBps, 'Rate');
  if (bps < 0n) throw invalid('Rate must not be negative');
  const result = divideRound(toMinor(minorUnits) * bps, 10000n);
  return assertInRange(result, label);
}

module.exports = {
  RATE_SCALE,
  RATE_SCALE_DECIMALS,
  BIGINT_MAX,
  toMinor,
  assertInRange,
  parseRate,
  divideRound,
  applyRate,
  divideByRate,
  applyBps
};
