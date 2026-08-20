const { test } = require('node:test');
const assert = require('node:assert/strict');

const totp = require('../src/services/totp');

/**
 * RFC 6238's own test vectors, which are the only real proof this is TOTP and
 * not something that merely looks like it. An authenticator app is not a thing
 * we control: if these pass, every app that implements the standard will agree
 * with us, and if they do not, no amount of local testing would have told us.
 *
 * The RFC publishes them for the ASCII seed "12345678901234567890"; the secret
 * here is that seed in base32, which is the form an otpauth URI carries.
 */
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890', 'ascii'));

test('base32 round-trips the RFC seed', () => {
  assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totp.base32Decode(RFC_SECRET).toString('ascii'), '12345678901234567890');
});

test('matches the RFC 6238 SHA-1 vectors', () => {
  // Time, then the eight-digit code the RFC prints. Ours is six digits, which
  // is the same number truncated -- so the expectation is its last six.
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130']
  ];

  for (const [seconds, eightDigits] of vectors) {
    const step = totp.stepAt(seconds * 1000);
    assert.equal(
      totp.codeForStep(RFC_SECRET, step),
      eightDigits.slice(-6),
      `RFC vector at T=${seconds}`
    );
  }
});

test('base32 decoding is tolerant of how apps write it, strict about the alphabet', () => {
  const secret = totp.generateSecret();
  assert.equal(totp.base32Decode(secret.toLowerCase()).toString('hex'),
    totp.base32Decode(secret).toString('hex'));
  assert.equal(totp.base32Decode(`${secret}====`).toString('hex'),
    totp.base32Decode(secret).toString('hex'));
  assert.throws(() => totp.base32Decode('AAAA1111'), /Invalid base32/);
});

test('a generated secret is 160 bits', () => {
  assert.equal(totp.base32Decode(totp.generateSecret()).length, 20);
});

/* --- verification ------------------------------------------------------- */

const at = 1_700_000_000_000;
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const codeAt = offset => totp.codeForStep(secret, totp.stepAt(at) + offset);

test('accepts the current code and reports its step', () => {
  const result = totp.verify(secret, codeAt(0), { at });
  assert.equal(result.step, totp.stepAt(at));
});

test('tolerates a clock one step out in either direction', () => {
  assert.ok(totp.verify(secret, codeAt(-1), { at }));
  assert.ok(totp.verify(secret, codeAt(1), { at }));
});

test('refuses a code two steps out', () => {
  // Every accepted step is another code an attacker may guess at any instant.
  assert.equal(totp.verify(secret, codeAt(-2), { at }), null);
  assert.equal(totp.verify(secret, codeAt(2), { at }), null);
});

test('a code already used cannot be used again', () => {
  // The replay this closes: a code read over somebody's shoulder stays valid
  // for the rest of its thirty seconds unless the step is remembered.
  const used = totp.stepAt(at);
  assert.equal(totp.verify(secret, codeAt(0), { at, notBeforeStep: used }), null);
  // ...and the step before it is refused too, not just the exact one.
  assert.equal(totp.verify(secret, codeAt(-1), { at, notBeforeStep: used }), null);
  // The next one still works, or the account would be locked out for good.
  assert.ok(totp.verify(secret, codeAt(1), { at, notBeforeStep: used }));
});

test('anything that is not six digits is refused without touching the secret', () => {
  for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', null, undefined, '000000 ']) {
    assert.equal(totp.verify(secret, bad, { at }), null, JSON.stringify(bad));
  }
});

test('an unreadable secret fails verification rather than throwing', () => {
  // This runs on the login path; a 500 here would be an outage, and the honest
  // answer to "does this code match a secret we cannot read" is no.
  assert.equal(totp.verify('not-base32-!!', '123456', { at }), null);
});

test('the otpauth URI carries what an authenticator needs', () => {
  const uri = totp.otpauthUri({ secret, account: 'ana+staff@example.com' });
  const parsed = new URL(uri);
  assert.equal(parsed.protocol, 'otpauth:');
  assert.equal(parsed.searchParams.get('secret'), secret);
  assert.equal(parsed.searchParams.get('issuer'), 'Splite');
  assert.equal(parsed.searchParams.get('digits'), '6');
  assert.equal(parsed.searchParams.get('period'), '30');
  // The `+` must survive as part of the address rather than becoming a space.
  assert.match(uri, /ana%2Bstaff%40example\.com/);
});
