const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normaliseRif, hasRifShape, rifCheckDigit, isValidRif, formatRif } = require('../src/utils/rif');

/**
 * The RIF check digit.
 *
 * These vectors were computed from the published mod-11 rule rather than read
 * back out of this implementation, because a test that asks the code what the
 * answer is and then agrees with it proves only that the code is deterministic.
 */

test('normalising erases how it was typed', () => {
  const spellings = ['J-12345678-4', 'j123456784', ' J 12345678 4 ', 'j-12345678-4'];
  for (const spelling of spellings) {
    assert.equal(normaliseRif(spelling), 'J123456784', `${spelling} should normalise`);
  }
});

test('normalising is what makes the unique index mean anything', () => {
  // Migration 012 puts a UNIQUE index on the stored value. If two spellings of
  // one taxpayer normalised differently they would both be accepted and the
  // restaurant would exist twice, with its bills split across two tenants that
  // cannot be merged.
  assert.equal(normaliseRif('J-12345678-4'), normaliseRif('J123456784'));
});

test('shape is checked after normalising, not before', () => {
  assert.ok(hasRifShape(normaliseRif('J-12345678-4')));
  assert.ok(!hasRifShape(normaliseRif('J-1234567-4')), 'too short');
  assert.ok(!hasRifShape(normaliseRif('J-123456789-4')), 'too long');
  assert.ok(!hasRifShape(normaliseRif('X-12345678-4')), 'X is not a taxpayer type');
  assert.ok(!hasRifShape(normaliseRif('')), 'empty');
});

test('check digits match the published algorithm', () => {
  const vectors = [
    ['J12345678', 4],
    ['V12345678', 1],
    ['E87654321', 7],
    ['G20000000', 7],
    ['P11111111', 7]
  ];
  for (const [prefix, expected] of vectors) {
    assert.equal(rifCheckDigit(prefix + expected), expected, prefix);
  }
});

test('a remainder of 0 or 1 collapses to check digit 0', () => {
  // 11 - 0 and 11 - 1 give 11 and 10, neither of which is a digit. Getting this
  // branch wrong rejects roughly one RIF in eleven, and does it only for the
  // unlucky, which is the kind of bug that reaches production.
  assert.equal(rifCheckDigit('J000000050'), 0, 'sum % 11 === 0');
  assert.equal(rifCheckDigit('J000000000'), 0, 'sum % 11 === 1');
});

test('a malformed value yields null, never a digit', () => {
  // 0 is a real check digit, so returning a number for unparseable input would
  // make "malformed" indistinguishable from "its checksum is zero".
  assert.equal(rifCheckDigit('nonsense'), null);
  assert.equal(rifCheckDigit('J1234567'), null);
  assert.equal(rifCheckDigit(''), null);
});

test('the checksum catches a mistyped digit', () => {
  // What it is actually for: transcription slips, not invention.
  assert.ok(isValidRif('J-12345678-4'));
  for (const wrong of [0, 1, 2, 3, 5, 6, 7, 8, 9]) {
    assert.ok(!isValidRif(`J-12345678-${wrong}`), `J-12345678-${wrong} should not verify`);
  }
});

test('a valid checksum is not evidence the RIF exists', () => {
  // Worth pinning so nobody later reads isValidRif as proof of a real taxpayer
  // and promotes it to a hard rejection on that basis.
  assert.ok(isValidRif('J-00000000-0'));
});

test('formatting round-trips through normalisation', () => {
  assert.equal(formatRif('j123456784'), 'J-12345678-4');
  assert.equal(formatRif('J-12345678-4'), 'J-12345678-4');
  // Unparseable input comes back normalised rather than throwing: this is a
  // display helper and a signup form must be able to echo what was typed.
  assert.equal(formatRif('nope'), 'NOPE');
});
