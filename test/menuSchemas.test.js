const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  menuCurrencySchema,
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema
} = require('../src/middleware/schemas');

const OPTIONS = { abortEarly: false, stripUnknown: true, convert: true };

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

test('menu currency is limited to the three supported values', () => {
  for (const currency of ['VES', 'USD', 'EUR']) {
    assert.equal(ok(menuCurrencySchema, { currency }).currency, currency);
  }
  assert.ok(fails(menuCurrencySchema, { currency: 'GBP' }));
  assert.ok(fails(menuCurrencySchema, { currency: 'ves' }));
  assert.ok(fails(menuCurrencySchema, {}));
});

test('a product price is a BIGINT minor-unit amount, normalised to a string', () => {
  assert.equal(ok(createProductSchema, { name: 'Arepa', priceMinorUnits: 250 }).priceMinorUnits, '250');
  assert.equal(ok(createProductSchema, { name: 'Arepa', priceMinorUnits: '250' }).priceMinorUnits, '250');
  // Free items are legitimate; negatives and fractions are not.
  assert.equal(ok(createProductSchema, { name: 'Agua', priceMinorUnits: 0 }).priceMinorUnits, '0');
  assert.ok(fails(createProductSchema, { name: 'Arepa', priceMinorUnits: -1 }));
  assert.ok(fails(createProductSchema, { name: 'Arepa', priceMinorUnits: 2.5 }));
});

test('a product cannot carry its own currency', () => {
  // The currency comes from the restaurant's menu currency, so a client cannot
  // create a product that disagrees with the menu it belongs to.
  const value = ok(createProductSchema, { name: 'Arepa', priceMinorUnits: 250, currency: 'USD' });
  assert.equal(value.currency, undefined, 'currency is stripped rather than honoured');
});

test('product names are trimmed and bounded', () => {
  assert.equal(ok(createProductSchema, { name: '  Arepa  ', priceMinorUnits: 1 }).name, 'Arepa');
  assert.ok(fails(createProductSchema, { name: '', priceMinorUnits: 1 }));
  assert.ok(fails(createProductSchema, { name: 'x'.repeat(161), priceMinorUnits: 1 }));
  assert.ok(fails(createProductSchema, { priceMinorUnits: 1 }));
});

test('a product defaults to active and accepts an empty description', () => {
  assert.equal(ok(createProductSchema, { name: 'Arepa', priceMinorUnits: 1 }).active, true);
  assert.equal(ok(createProductSchema, { name: 'Arepa', priceMinorUnits: 1, description: '' }).description, '');
  assert.equal(ok(createProductSchema, { name: 'Arepa', priceMinorUnits: 1, description: null }).description, null);
});

test('a product update must change something', () => {
  ok(updateProductSchema, { active: false });
  ok(updateProductSchema, { priceMinorUnits: 500 });
  assert.match(fails(updateProductSchema, {}), /at least 1 key/);
});

test('product listing paginates and filters like the other list endpoints', () => {
  assert.deepEqual(ok(listProductsQuerySchema, {}), { limit: 50, offset: 0 });
  assert.equal(ok(listProductsQuerySchema, { active: 'false' }).active, false);
  assert.ok(fails(listProductsQuerySchema, { limit: 101 }));
  assert.ok(fails(listProductsQuerySchema, { offset: -1 }));
});
