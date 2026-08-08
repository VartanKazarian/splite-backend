const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createTableSchema,
  updateTableSchema,
  createBillSchema,
  listTablesQuerySchema,
  listBillsQuerySchema
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

test('a bill requires a uuid table id and defaults to VES', () => {
  assert.equal(ok(createBillSchema, { tableId: UUID, totalDueMinorUnits: 1 }).currency, 'VES');
  assert.ok(fails(createBillSchema, { tableId: 'not-a-uuid', totalDueMinorUnits: 1 }));
  assert.ok(fails(createBillSchema, { totalDueMinorUnits: 1 }));
  assert.ok(fails(createBillSchema, { tableId: UUID, totalDueMinorUnits: 1, currency: 'EUR' }));
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
