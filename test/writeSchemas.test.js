const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createTableSchema,
  updateTableSchema,
  createBillSchema,
  listTablesQuerySchema,
  listBillsQuerySchema,
  declareClaimSchema
} = require('../src/middleware/schemas');

const OPTIONS = { abortEarly: false, stripUnknown: true, convert: true };
const UUID = '11111111-1111-4111-8111-111111111111';

const ok = (schema, input) => {
  const { error, value } = schema.validate(input, OPTIONS);
  assert.equal(error, undefined, error && error.message);
  return value;
};
const fails = (schema, input) => {
  const { error } = schema.validate(input, OPTIONS);
  assert.ok(error, 'expected a validation error');
  return error.details.map(d => d.message).join('; ');
};

test('bill totals arrive as strings regardless of how they were sent', () => {
  assert.equal(ok(createBillSchema, { tableId: UUID, totalDueMinorUnits: 5000 }).totalDueMinorUnits, '5000');
  assert.equal(ok(createBillSchema, { tableId: UUID, totalDueMinorUnits: '5000' }).totalDueMinorUnits, '5000');
});

test('a total beyond 2^53 survives when sent as a string', () => {
  // Sent as a JSON number this value has already been rounded by the client's
  // parser; the string form is the only one that reaches Postgres intact.
  const value = ok(createBillSchema, { tableId: UUID, totalDueMinorUnits: '9007199254740993' });
  assert.equal(value.totalDueMinorUnits, '9007199254740993');
});

test('bill totals reject negatives, fractions and values past BIGINT', () => {
  assert.match(fails(createBillSchema, { tableId: UUID, totalDueMinorUnits: -1 }), /greater than or equal to 0/);
  assert.match(fails(createBillSchema, { tableId: UUID, totalDueMinorUnits: 10.5 }), /must be an integer/);
  assert.ok(fails(createBillSchema, { tableId: UUID, totalDueMinorUnits: '9223372036854775808' }));
  assert.ok(fails(createBillSchema, { tableId: UUID, totalDueMinorUnits: 'abc' }));
});

test('a bill requires a uuid table id and cannot choose its own currency', () => {
  // The currency comes from the restaurant's menu, so a client cannot open a
  // bill in one the menu does not use.
  const value = ok(createBillSchema, { tableId: UUID, totalDueMinorUnits: 1, currency: 'EUR' });
  assert.equal(value.currency, undefined, 'currency is stripped rather than honoured');
  assert.ok(fails(createBillSchema, { tableId: 'not-a-uuid', totalDueMinorUnits: 1 }));
  assert.ok(fails(createBillSchema, { totalDueMinorUnits: 1 }));
});

test('table names are trimmed and bounded', () => {
  assert.equal(ok(createTableSchema, { name: '  T1  ' }).name, 'T1');
  assert.ok(fails(createTableSchema, { name: '' }));
  assert.ok(fails(createTableSchema, { name: 'x'.repeat(51) }));
  assert.ok(fails(createTableSchema, {}));
});

test('a table update must actually change something', () => {
  ok(updateTableSchema, { active: false });
  ok(updateTableSchema, { name: 'T9' });
  assert.match(fails(updateTableSchema, {}), /at least 1 key/);
});

test('list queries default their pagination', () => {
  assert.deepEqual(ok(listBillsQuerySchema, {}), { limit: 50, offset: 0 });
  assert.deepEqual(ok(listTablesQuerySchema, {}), { limit: 50, offset: 0 });
});

test('pagination is bounded so a caller cannot ask for the whole table', () => {
  assert.equal(ok(listBillsQuerySchema, { limit: '100' }).limit, 100);
  assert.ok(fails(listBillsQuerySchema, { limit: 101 }));
  assert.ok(fails(listBillsQuerySchema, { limit: 0 }));
  assert.ok(fails(listBillsQuerySchema, { offset: -1 }));
});

test('list filters only accept known values', () => {
  assert.equal(ok(listBillsQuerySchema, { status: 'OPEN' }).status, 'OPEN');
  assert.ok(fails(listBillsQuerySchema, { status: 'PAID' }));
  assert.ok(fails(listBillsQuerySchema, { tableId: 'not-a-uuid' }));
  assert.equal(ok(listTablesQuerySchema, { active: 'true' }).active, true);
});

test('a payment amount is exact at any size the column holds', () => {
  const { splitPaymentSchema } = require('../src/middleware/schemas');
  const payment = amount => splitPaymentSchema.validate(
    { billId: UUID, amountMinorUnits: amount, currency: 'VES', idempotencyKey: 'k0123456789abcdef' },
    OPTIONS
  );

  // The previous schema coerced through Joi.number() before validating, so even
  // this exact string was rounded and then rejected as unsafe — capping payments
  // below 2^53 while the column and the arithmetic both went further.
  assert.equal(payment('9007199254740993').value.amountMinorUnits, '9007199254740993');
  assert.equal(payment(5000).value.amountMinorUnits, '5000', 'integers are still accepted');
});

test('a payment amount that already lost precision is refused', () => {
  const { splitPaymentSchema } = require('../src/middleware/schemas');
  const payment = amount => splitPaymentSchema.validate(
    { billId: UUID, amountMinorUnits: amount, currency: 'VES', idempotencyKey: 'k0123456789abcdef' },
    OPTIONS
  );

  // A JSON number past 2^53 was rounded by the client's parser before it
  // arrived; banking whatever it became would be worse than refusing it.
  // The literal below *is* what a client's parser would have handed us, so
  // eslint-disable-next-line no-loss-of-precision -- the rounding is the point.
  assert.ok(payment(9007199254740993).error);
  for (const bad of ['0', '-1', '1.5', 'abc', '']) assert.ok(payment(bad).error, `expected ${bad} refused`);
});

// --- A declared Pago Móvil ------------------------------------------------
//
// The diner sends the money from their own bank; nothing of ours sees it
// arrive. All three origin fields exist so a person at the till can find the
// movement in the bank app, which is why they are validated as the facts they
// are rather than as free text.

const claim = (over = {}) => ({ amountVes: '2500', reference: '123456789012', ...over });

test('a declared payment carries the payer as three matchable facts', () => {
  const value = ok(declareClaimSchema, claim({
    phoneOrigin: '0414-555.12.34', bankOrigin: '0134', idOrigin: 'v12345678'
  }));
  assert.equal(value.bankOrigin, '0134');
  // Upper-cased on the way in, so 'v12345678' and 'V12345678' are one person
  // and not two rows a verifier has to reconcile by eye.
  assert.equal(value.idOrigin, 'V12345678');
});

test('the payer\'s bank is a code, not a name somebody typed', () => {
  // "Banesco", "banesco" and "BANESCO 0134" are one bank that compares as
  // three, and the verifier reading the screen pays for the difference.
  assert.match(fails(declareClaimSchema, claim({ bankOrigin: 'Banesco' })), /known Venezuelan bank code/);
  assert.match(fails(declareClaimSchema, claim({ bankOrigin: '0999' })), /known Venezuelan bank code/);
});

test('a declared payment cannot have originated on a landline', () => {
  // Not strictness for its own sake: a Pago Móvil has no other origin, so a
  // landline here is a typo, and a typo in the one field that finds the
  // movement is worse than a blank.
  assert.match(fails(declareClaimSchema, claim({ phoneOrigin: '0212-5551234' })), /mobile line/);
  assert.equal(ok(declareClaimSchema, claim({ phoneOrigin: '04221234567' })).phoneOrigin, '04221234567');
});

test('a bare number is not an identity document', () => {
  assert.match(fails(declareClaimSchema, claim({ idOrigin: '12345678' })), /cédula or RIF/);
});

test('all three corroborating fields stay optional', () => {
  // The reference is what makes a claim checkable and it is required. These
  // only make it quicker, and a diner who cannot supply them is still a diner
  // who paid.
  const value = ok(declareClaimSchema, claim());
  assert.equal(value.phoneOrigin, undefined);
  assert.equal(value.bankOrigin, undefined);
  assert.equal(value.idOrigin, undefined);
});
