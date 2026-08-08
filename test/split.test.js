const test = require('node:test');
const assert = require('node:assert/strict');
const { allocate, splitEvenly, usdReference } = require('../src/services/split');

const sum = parts => parts.reduce((a, b) => a + BigInt(b), 0n);

test('an even split always sums to the exact total', () => {
  for (const total of [7567, 1, 2, 100, 99999, 1000003]) {
    for (const diners of [1, 2, 3, 4, 7, 13]) {
      assert.equal(sum(splitEvenly(total, diners)), BigInt(total), `${total} / ${diners}`);
    }
  }
});

test('remainder céntimos go to the earliest shares', () => {
  assert.deepEqual(splitEvenly(7567, 3), ['2523', '2522', '2522']);
  assert.deepEqual(splitEvenly(10, 4), ['3', '3', '2', '2']);
});

test('weighted allocation sums to the exact total', () => {
  const parts = allocate(10000, [1, 2, 3]);
  assert.deepEqual(parts, ['1667', '3333', '5000']);
  assert.equal(sum(parts), 10000n);
});

test('shares never differ by more than one céntimo in an even split', () => {
  const parts = splitEvenly(1000001, 7).map(BigInt);
  assert.ok(parts.reduce((a, b) => (a > b ? a : b)) - parts.reduce((a, b) => (a < b ? a : b)) <= 1n);
});

test('allocation is exact beyond 2^53 céntimos', () => {
  const total = '9007199254740993';
  const parts = splitEvenly(total, 3);
  assert.equal(sum(parts), BigInt(total));
});

test('a zero total splits into zeroes', () => {
  assert.deepEqual(splitEvenly(0, 3), ['0', '0', '0']);
});

test('invalid inputs are rejected', () => {
  assert.throws(() => splitEvenly(100, 0));
  assert.throws(() => splitEvenly(100, 1.5));
  assert.throws(() => allocate(100, []));
  assert.throws(() => allocate(100, [1, 0]));
  assert.throws(() => allocate(-1, [1]));
});

test('usdReference converts céntimos at the locked rate', () => {
  assert.equal(usdReference(756710, '756.710000'), '10.00');
  assert.equal(usdReference(0, '756.71'), '0.00');
});

test('usdReference returns null rather than guessing', () => {
  for (const rate of [null, undefined, 0, -1, 'abc']) {
    assert.equal(usdReference(756710, rate), null);
  }
});
