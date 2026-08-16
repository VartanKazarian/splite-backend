const { test } = require('node:test');
const assert = require('node:assert/strict');

const banks = require('../src/payments/banks');
const { payoutSchema } = require('../src/middleware/schemas');

test('every code is four digits and every entry names its bank', () => {
  for (const code of banks.CODES) {
    assert.match(code, /^0[0-9]{3}$/, code);
    assert.ok(banks.BANKS[code].name.length > 2, code);
    // `integration` must be present even when null. Absent would read as "not
    // yet decided"; null says "we have no module for this bank", which is the
    // fact the payout screen needs in order to be honest with a restaurant.
    assert.ok('integration' in banks.BANKS[code], code);
  }
});

test('knowing a bank is not the same as being able to charge it', () => {
  // Nothing has a module yet. When one lands this test changes deliberately,
  // rather than the distinction quietly eroding.
  assert.ok(banks.isKnown('0105'));
  assert.equal(banks.hasIntegration('0105'), false);
  assert.equal(banks.isKnown('0999'), false);
});

test('a well-formed code that is not a real bank is still rejected', () => {
  // Format alone would accept this, which is why the schema checks membership.
  assert.equal(banks.lookup('0999'), null);
});

test('reads the bank out of an account number', () => {
  assert.equal(banks.bankOfAccount('01050000000000000001'), '0105');
});

test('the picker is ordered for a human, not by code', () => {
  const names = banks.list().map(b => b.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'es')));
});

test('refuses an account number that belongs to another bank', () => {
  // The common entry error: the right account under the wrong bank in the
  // picker. It would otherwise only surface as a payment that never arrives.
  const { error } = payoutSchema.validate({
    bankCode: '0134',
    accountNumber: '01050000000000000001',
    phone: '04121234567',
    holderId: 'J123456789'
  });
  assert.match(error.message, /does not belong to that bank/);
});

test('refuses a half-filled payee', () => {
  // Half-filled looks configured on screen and cannot receive money, and the
  // failure lands on a diner holding a phone.
  const { error } = payoutSchema.validate({
    bankCode: '0105', accountNumber: '01050000000000000001'
  });
  assert.ok(error, 'all four together or none');
});

test('accepts an empty object, which is how a payee is cleared', () => {
  assert.equal(payoutSchema.validate({}).error, undefined);
});

test('takes a cédula or a RIF as the holder', () => {
  for (const holderId of ['V12345678', 'J123456789', 'E8765432']) {
    const { error } = payoutSchema.validate({
      bankCode: '0105', accountNumber: '01050000000000000001',
      phone: '04121234567', holderId
    });
    assert.equal(error, undefined, holderId);
  }
  const bad = payoutSchema.validate({
    bankCode: '0105', accountNumber: '01050000000000000001',
    phone: '04121234567', holderId: '12345678'
  });
  assert.ok(bad.error, 'a bare number is neither');
});
