const test = require('node:test');
const assert = require('node:assert/strict');
const { splitPaymentSchema, loginSchema, validateBody } = require('../src/middleware/schemas');

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const validPayment = { billId: UUID, amountMinorUnits: 1500, currency: 'VES', idempotencyKey: 'abcdefghijklmnop1234' };

test('payment schema accepts a well-formed body', () => {
  const { error, value } = splitPaymentSchema.validate(validPayment);
  assert.equal(error, undefined);
  // Normalised to a digit string, so every call site downstream sees one type
  // and an amount past 2^53 survives the request intact.
  assert.equal(value.amountMinorUnits, '1500');
});

test('payment schema rejects non-positive and fractional amounts', () => {
  for (const amount of [0, -1, 10.5]) {
    assert.ok(splitPaymentSchema.validate({ ...validPayment, amountMinorUnits: amount }).error);
  }
});

test('payment schema rejects unsupported currencies and non-uuid bill ids', () => {
  assert.ok(splitPaymentSchema.validate({ ...validPayment, currency: 'EUR' }).error);
  assert.ok(splitPaymentSchema.validate({ ...validPayment, billId: 'not-a-uuid' }).error);
});

test('payment schema rejects short idempotency keys', () => {
  assert.ok(splitPaymentSchema.validate({ ...validPayment, idempotencyKey: 'short' }).error);
});

test('login schema normalises email case', () => {
  const { value } = loginSchema.validate({ email: 'Owner@Example.COM', password: 'secret' });
  assert.equal(value.email, 'owner@example.com');
});

test('validateBody strips unknown keys and returns every error at once', () => {
  const req = { body: { ...validPayment, isAdmin: true } };
  const res = { statusCode: null, payload: null, status(c) { this.statusCode = c; return this; }, json(p) { this.payload = p; return this; } };
  let nexted = false;

  validateBody(splitPaymentSchema)(req, res, () => { nexted = true; });
  assert.equal(nexted, true);
  assert.equal(req.body.isAdmin, undefined);

  // A validation failure now raises the standard envelope like every other
  // error, with the per-field list under details.fields. It used to be the
  // whole body -- `{ error: [...] }` -- a third shape clients had to know.
  const bad = { body: { currency: 'EUR', amountMinorUnits: -1 } };
  let raised = null;
  validateBody(splitPaymentSchema)(bad, res, err => { raised = err; });

  assert.ok(raised, 'an invalid body must not reach the handler');
  assert.equal(raised.code, 'VALIDATION_FAILED');
  assert.equal(raised.statusCode, 400);
  assert.ok(raised.details.fields.length > 1, 'every failing field is reported at once');
});
