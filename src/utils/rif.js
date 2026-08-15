/**
 * The Venezuelan RIF (Registro Único de Información Fiscal).
 *
 * Shape is a type letter, eight digits and a check digit: `J-12345678-9`.
 * The letter says what kind of taxpayer it is -- J is the one a restaurant
 * almost always has (jurídico), V and E are natural persons, G is government,
 * P is passport.
 *
 * A format check alone is nearly worthless here: `^[VEJPG]-\d{8}-\d$` accepts
 * J-12345678-9, and a signup form is exactly where somebody types whatever gets
 * them past the field. The check digit is what makes the value mean something,
 * so it is computed -- but see `isValidRif` for why computing it is not the
 * same as enforcing it.
 *
 * (J-12345678-4 is the one that verifies. J-00000000-0 verifies too, which is
 * worth knowing before treating a checksum as proof that a human typed a real
 * number: it catches transcription slips, not invention.)
 */

// The type letter is worth 4 × its own value in the sum.
const TYPE_VALUES = { V: 1, E: 2, J: 3, P: 4, G: 5 };
const TYPE_MULTIPLIER = 4;

// Applied left to right across the eight body digits.
const DIGIT_WEIGHTS = [3, 2, 7, 6, 5, 4, 3, 2];

const NORMALISED = /^([VEJPG])(\d{8})(\d)$/;

/**
 * Strips presentation and uppercases: `j-12345678-9` and `J123456789` both
 * become `J123456789`.
 *
 * Everything that stores or compares a RIF must go through this first. The
 * unique index in migration 012 is on the stored value, so normalising at only
 * some call sites would let the same taxpayer register twice with two
 * spellings, which is the exact failure the index exists to prevent.
 */
function normaliseRif(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Whether the value is shaped like a RIF at all, after normalisation. */
function hasRifShape(normalised) {
  return NORMALISED.test(normalised);
}

/**
 * The mod-11 check digit for a normalised RIF.
 *
 * Returns null when the input is not RIF-shaped, so a caller cannot mistake
 * "malformed" for "checksum is 0" -- and 0 is a real check digit, which is what
 * makes returning a number for bad input dangerous rather than merely sloppy.
 */
function rifCheckDigit(normalised) {
  const match = NORMALISED.exec(normalised);
  if (!match) return null;

  const [, letter, body] = match;
  let sum = TYPE_VALUES[letter] * TYPE_MULTIPLIER;
  for (let i = 0; i < DIGIT_WEIGHTS.length; i++) {
    sum += Number(body[i]) * DIGIT_WEIGHTS[i];
  }

  const candidate = 11 - (sum % 11);
  // A remainder of 0 or 1 yields 11 or 10, neither of which is a digit; both
  // collapse to 0. Missing this is the classic way to reject one RIF in eleven.
  return candidate > 9 ? 0 : candidate;
}

/**
 * Whether the check digit agrees with the rest of the number.
 *
 * Deliberately not wired to a rejection. This implementation has not been run
 * against a corpus of real RIFs, and the cost of the two mistakes is wildly
 * asymmetric: storing a malformed tax id is a data-quality problem someone
 * fixes later, while refusing a real restaurant at the registration form loses
 * the customer silently and forever. `restaurant_signups.rif_checksum_ok`
 * records the verdict so the decision can be made from evidence.
 */
function isValidRif(input) {
  const normalised = normaliseRif(input);
  const expected = rifCheckDigit(normalised);
  if (expected === null) return false;
  return Number(normalised[9]) === expected;
}

/** `J123456789` back to `J-12345678-9`, for display. */
function formatRif(input) {
  const normalised = normaliseRif(input);
  if (!hasRifShape(normalised)) return normalised;
  return `${normalised[0]}-${normalised.slice(1, 9)}-${normalised[9]}`;
}

module.exports = { normaliseRif, hasRifShape, rifCheckDigit, isValidRif, formatRif, TYPE_VALUES };
