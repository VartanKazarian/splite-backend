const { test } = require('node:test');
const assert = require('node:assert/strict');

const { CODES, DETAILS, ApiError } = require('../src/errors');

/**
 * The error contract is the one a client branches on, so it is tested as a
 * contract rather than left to whatever each route happens to construct.
 */

test('a code always carries exactly one status', () => {
  // The whole point of branching on `code` is that it alone tells the client
  // what happened. A code that meant 404 on one route and 409 on another would
  // force them to check both.
  for (const [code, status] of Object.entries(CODES)) {
    assert.equal(typeof status, 'number', `${code} has no status`);
    assert.ok(status >= 400 && status < 600, `${code} maps to ${status}, which is not an error status`);
  }
});

test('codes are SCREAMING_SNAKE, so they read as constants at a call site', () => {
  for (const code of Object.keys(CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/, `${code} is not a stable-looking identifier`);
  }
});

test('an unknown code is refused at construction', () => {
  // A typo would otherwise reach a client as an undefined status and a code
  // nothing can match. Failing loudly here turns that into a test failure.
  assert.throws(() => new ApiError('NOT_A_REAL_CODE', 'x'), /Unknown error code/);
});

test('an ApiError carries its status, code and details', () => {
  const err = new ApiError('OPEN_BILL_EXISTS', 'Already open', { billId: 'b1' });
  assert.equal(err.statusCode, 409);
  assert.equal(err.code, 'OPEN_BILL_EXISTS');
  assert.deepEqual(err.details, { billId: 'b1' });
  assert.ok(err instanceof Error, 'must still be throwable and catchable as an Error');
});

test('details default to an empty object, never undefined', () => {
  // So `error.details.billId` reads as undefined rather than throwing on the
  // responses that carry nothing extra.
  assert.deepEqual(new ApiError('BILL_NOT_FOUND', 'x').details, {});
});

test('every documented details payload belongs to a real code', () => {
  const unknown = Object.keys(DETAILS).filter(code => !(code in CODES));
  assert.deepEqual(unknown, [], 'x-error-details describes codes that do not exist');
});

test('the codes a client is most likely to branch on are present', () => {
  // Named explicitly: these drive navigation and retry decisions in the client,
  // so removing one is a breaking change and should fail here first.
  for (const code of [
    'OPEN_BILL_EXISTS', 'BILL_NOT_OPEN', 'PAYMENT_EXCEEDS_BALANCE',
    'IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_FLIGHT',
    'MENU_CURRENCY_MISMATCH', 'RATE_LIMITED', 'FX_UNAVAILABLE',
    'AUTH_TOKEN_INVALID', 'FORBIDDEN_ROLE', 'VALIDATION_FAILED'
  ]) {
    assert.ok(code in CODES, `${code} is missing from the registry`);
  }
});

test('OPEN_BILL_EXISTS is a 409 that hands back the bill to navigate to', () => {
  // The case the client-side flow depends on: a waiter opens a bill on a table
  // that already has one, and the app should route to the existing bill rather
  // than surface an error string.
  assert.equal(CODES.OPEN_BILL_EXISTS, 409);
  assert.ok(DETAILS.OPEN_BILL_EXISTS.billId, 'the existing bill id must be part of the contract');
});
