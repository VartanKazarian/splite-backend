const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  toMinor,
  parseRate,
  applyRate,
  divideByRate,
  applyBps,
  divideRound,
  RATE_SCALE
} = require('../src/services/money');

test('parses a decimal rate exactly, without going through a float', () => {
  // 757.5406 is not exactly representable in binary floating point; parsing the
  // string form avoids the question entirely.
  assert.equal(parseRate('757.5406'), 75754060000n);
  assert.equal(parseRate('757.54060000'), 75754060000n);
  assert.equal(parseRate('1'), RATE_SCALE);
  assert.equal(parseRate(757.5406), 75754060000n);
});

test('rejects a rate that is not usable', () => {
  for (const bad of ['0', '-5', 'abc', '', 'NaN']) {
    assert.throws(() => parseRate(bad), /rate/i, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('a rate failure is a 503, not a 400', () => {
  // The rate is an upstream dependency; a bad one is not the caller's fault.
  try {
    parseRate('nonsense');
    assert.fail('should have thrown');
  } catch (err) {
    assert.equal(err.statusCode, 503);
  }
});

test('applies basis points with half-up rounding', () => {
  assert.equal(applyBps(1000n, 1600), 160n);   // 16% VAT
  assert.equal(applyBps(1000n, 1000), 100n);   // 10% tip
  assert.equal(applyBps(333n, 1000), 33n);     // 33.3 -> 33
  assert.equal(applyBps(335n, 1000), 34n);     // 33.5 -> 34, away from zero
  assert.equal(applyBps(1000n, 0), 0n);
});

test('converts between menu currency and VES at an exact rate', () => {
  const rate = parseRate('757.5406');
  // $10.00 = 1000 minor units USD
  assert.equal(applyRate(1000n, rate), 757541n);
  assert.equal(divideByRate(757541n, rate), 1000n);
});

test('keeps amounts exact beyond 2^53 minor units', () => {
  const rate = parseRate('1');
  const huge = 9007199254740993n; // 2^53 + 1
  assert.equal(applyRate(huge, rate), huge);
  assert.equal(toMinor('9007199254740993'), huge);
  // The same value through Number would have been rounded on the way in.
  assert.notEqual(BigInt(Number('9007199254740993')), huge);
});

test('rejects amounts past what a BIGINT column can hold', () => {
  const rate = parseRate('1000');
  assert.throws(() => applyRate(9223372036854775807n, rate), /supported monetary range/);
});

test('rejects values that are not exact integers', () => {
  assert.throws(() => toMinor(10.5), /exact integer/);
  assert.throws(() => toMinor('10.5'), /valid amount/);
  assert.throws(() => toMinor(Number.MAX_SAFE_INTEGER + 2), /exact integer/);
});

test('divideRound rounds halves away from zero in both directions', () => {
  assert.equal(divideRound(5n, 2n), 3n);
  assert.equal(divideRound(-5n, 2n), -3n);
  assert.equal(divideRound(4n, 2n), 2n);
  assert.equal(divideRound(1n, 3n), 0n);
});

test('the per-participant tip discrepancy is gone', () => {
  // The float version computed each share as 1000 / 3 = 333.3333..., took 10%
  // of each, and summed to 99 where the tip on the whole line is 100.
  const { allocate } = require('../src/services/split');
  const shares = allocate('1000', [1, 1, 1]).map(BigInt);

  assert.deepEqual(shares.map(String), ['334', '333', '333']);
  assert.equal(shares.reduce((a, b) => a + b, 0n), 1000n, 'shares sum to the line total exactly');

  // Allocating the tip itself, rather than taking a percentage of each share,
  // is what makes the parts add up.
  const tipTotal = applyBps(1000n, 1000);
  const tipShares = allocate(tipTotal.toString(), [1, 1, 1]).map(BigInt);
  assert.equal(tipTotal, 100n);
  assert.equal(tipShares.reduce((a, b) => a + b, 0n), 100n, 'and so does the tip');
});
