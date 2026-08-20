const crypto = require('crypto');

/**
 * Time-based one-time passwords, RFC 6238.
 *
 * Written out rather than pulled in, for the same reason the webhook HMAC is:
 * it is forty lines of standard, the standard has not moved since 2011, and a
 * dependency in the authentication path is a supply chain in the
 * authentication path.
 *
 * SHA-1, six digits, thirty-second steps. Those are not choices so much as the
 * defaults every authenticator app assumes when it scans a QR code -- Google
 * Authenticator, Aegis and 1Password all ignore an `algorithm` parameter that
 * says otherwise, or refuse the code outright. SHA-1 is weak for collision
 * resistance and irrelevant here: HMAC-SHA1's security rests on the key, and
 * the key is 160 random bits that live for one account.
 */

const DIGITS = 6;
const STEP_SECONDS = 30;

/**
 * How many steps either side of now are accepted.
 *
 * One, so a phone clock thirty seconds out still works. Every extra step is
 * another code an attacker may guess at any instant, and users whose clocks are
 * minutes out are better served by fixing the clock than by us widening the
 * door.
 */
const DEFAULT_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, which is what an otpauth:// URI carries. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  // Padding and casing vary between the apps that produce these; the alphabet
  // does not.
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * A fresh secret: 20 bytes, the SHA-1 block-matched length RFC 4226 recommends.
 */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/** Which 30-second step a moment falls in. */
function stepAt(atMs = Date.now()) {
  return Math.floor(atMs / 1000 / STEP_SECONDS);
}

/** The code for one step. Exported so tests can drive it from a fixed clock. */
function codeForStep(secret, step, { digits = DIGITS, algorithm = 'sha1' } = {}) {
  const key = base32Decode(secret);

  // The counter is a 64-bit big-endian integer. BigInt rather than a shifted
  // Number: step numbers stay well inside 2^53 for the next few million years,
  // but writing it this way means the arithmetic is exact by construction
  // rather than by an argument about how far away the year 275760 is.
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = crypto.createHmac(algorithm, key).update(counter).digest();

  // Dynamic truncation, RFC 4226 section 5.3: the low nibble of the last byte
  // picks the offset, and the high bit of the selected word is masked off so
  // the result is the same on a signed-integer implementation.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a submitted code, and says which step it matched.
 *
 * The step comes back because the caller has to record it: a code stays valid
 * for the whole of its step, so without remembering the last one accepted, a
 * code read over somebody's shoulder can be replayed for the remainder of its
 * thirty seconds. `notBeforeStep` is how that memory is applied.
 *
 * Comparison is constant-time. The value being compared is only six digits, so
 * the timing signal is small -- but it is a comparison against a secret-derived
 * value in the authentication path, and the cheap version has no upside.
 */
function verify(secret, code, { at = Date.now(), window = DEFAULT_WINDOW, notBeforeStep = null } = {}) {
  const submitted = String(code || '').trim();
  if (!/^[0-9]{6}$/.test(submitted)) return null;

  const current = stepAt(at);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (notBeforeStep !== null && step <= notBeforeStep) continue;

    let expected;
    try {
      expected = codeForStep(secret, step);
    } catch {
      return null;   // an unreadable secret is a failed verification, not a 500
    }

    const a = Buffer.from(expected);
    const b = Buffer.from(submitted);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return { step };
  }
  return null;
}

/**
 * The otpauth:// URI an authenticator scans.
 *
 * The label carries the account and the issuer, and the issuer is repeated as a
 * parameter because the two are read by different apps. Both are encoded: an
 * email address with a `+` in it, unescaped, silently truncates the account
 * name in some readers.
 */
function otpauthUri({ secret, account, issuer = 'Splite' }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  generateSecret, verify, codeForStep, stepAt, otpauthUri,
  base32Encode, base32Decode,
  DIGITS, STEP_SECONDS, DEFAULT_WINDOW
};
