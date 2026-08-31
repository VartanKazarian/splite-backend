const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dto = require('../src/dto');
const {
  createProductSchema, updateProductSchema, listProductsQuerySchema, menuOcrImportSchema
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
};

const UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

/**
 * Menu sections.
 *
 * The reader has always extracted them -- `section` is in the extraction prompt
 * and every draft carries one -- and the import dropped them, so a restaurant's
 * own structure arrived as one alphabetical list. These cover the contract that
 * carries it through, and the two places the distinction is easy to lose:
 * uncategorised is a state rather than a missing value, and an omitted
 * categoryId is not the same as a null one.
 */

test('the import accepts the section the reader found', () => {
  const value = ok(menuOcrImportSchema, {
    items: [{ name: 'Tequeños', priceMinorUnits: '600', section: 'Entradas' }]
  });
  assert.equal(value.items[0].section, 'Entradas');
});

test('a section is optional, and may be explicitly absent', () => {
  // A menu with no printed headings yields none, and a reviewer may clear one
  // that was misread. Neither is an error.
  ok(menuOcrImportSchema, { items: [{ name: 'Café', priceMinorUnits: '100' }] });
  ok(menuOcrImportSchema, { items: [{ name: 'Café', priceMinorUnits: '100', section: null }] });
  ok(menuOcrImportSchema, { items: [{ name: 'Café', priceMinorUnits: '100', section: '' }] });
});

test('a section longer than the column is refused', () => {
  fails(menuOcrImportSchema, {
    items: [{ name: 'Café', priceMinorUnits: '100', section: 'x'.repeat(81) }]
  });
});

test('a product can be created into a section, or into none', () => {
  assert.equal(ok(createProductSchema, { name: 'A', priceMinorUnits: '100', categoryId: UUID }).categoryId, UUID);
  assert.equal(ok(createProductSchema, { name: 'A', priceMinorUnits: '100', categoryId: null }).categoryId, null);
  assert.equal(ok(createProductSchema, { name: 'A', priceMinorUnits: '100' }).categoryId, undefined);
  fails(createProductSchema, { name: 'A', priceMinorUnits: '100', categoryId: 'not-a-uuid' });
});

test('on update, omitting categoryId differs from sending null', () => {
  // The route reads this distinction with hasOwnProperty: null means "out of
  // every section", which somebody meant to do; absent means "leave it".
  const cleared = ok(updateProductSchema, { categoryId: null });
  assert.ok(Object.prototype.hasOwnProperty.call(cleared, 'categoryId'));
  assert.equal(cleared.categoryId, null);

  const untouched = ok(updateProductSchema, { name: 'B' });
  assert.ok(!Object.prototype.hasOwnProperty.call(untouched, 'categoryId'));
});

test('the list filters by section, and by having none', () => {
  assert.equal(ok(listProductsQuerySchema, { categoryId: UUID }).categoryId, UUID);
  // Without this the uncategorised bucket is unreachable: it has no id, so a
  // client rendering section by section could show every group but that one.
  assert.equal(ok(listProductsQuerySchema, { categoryId: 'none' }).categoryId, 'none');
  fails(listProductsQuerySchema, { categoryId: 'nope' });
});

test('a product reports its section, and null when it has none', () => {
  const filed = dto.product({
    id: '1', name: 'Tequeños', price_minor_units: '600', currency: 'VES',
    category_id: 'cat-1', category_name: 'Entradas', position: 3, active: true
  });
  assert.equal(filed.categoryId, 'cat-1');
  assert.equal(filed.categoryName, 'Entradas');
  assert.equal(filed.position, 3);

  const loose = dto.product({
    id: '2', name: 'Café', price_minor_units: '100', currency: 'VES', active: true
  });
  assert.equal(loose.categoryId, null);
  assert.equal(loose.categoryName, null);
  // Not undefined: a client sorting on it must not have to special-case the
  // uncategorised ones.
  assert.equal(loose.position, 0);
});

test('the public product carries the section a diner needs to navigate', () => {
  const p = dto.publicProduct({
    id: '1', name: 'Cerveza', price_minor_units: '200', currency: 'VES',
    category_id: 'cat-2', category_name: 'Bebidas'
  });
  assert.equal(p.categoryName, 'Bebidas');
  // Still narrower than the staff shape: no active flag, no timestamps.
  assert.deepEqual(Object.keys(p).sort(),
    ['categoryId', 'categoryName', 'currency', 'description', 'id', 'name', 'priceMinorUnits']);
});

test('a category omits productCount unless the query counted', () => {
  assert.equal(dto.menuCategory({ id: 'c', name: 'Postres', position: 2, active: true }).productCount, undefined);
  assert.equal(dto.menuCategory({ id: 'c', name: 'Postres', position: 2, active: true, product_count: '4' }).productCount, 4);
});

/**
 * The migration itself, read as text.
 *
 * The integration suite exercises it against a real database; this catches the
 * two things that are wrong in a way a passing query would not reveal.
 */
test('the category foreign key is tenant-scoped and nulls only its own column', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '031_menu_categories.sql'), 'utf8');

  // A plain REFERENCES menu_categories(id) would let one restaurant file its
  // food under another restaurant's section: the id exists, and nothing in the
  // constraint says whose it is.
  assert.match(sql, /FOREIGN KEY \(category_id, restaurant_id\)/);
  assert.match(sql, /REFERENCES menu_categories \(id, restaurant_id\)/);
  assert.match(sql, /UNIQUE \(id, restaurant_id\)/);

  // On a composite key the unqualified form nulls every referencing column,
  // which here would blank menu_products.restaurant_id -- the tenant off the
  // product. 030_bill_served_by hit exactly that.
  assert.match(sql, /ON DELETE SET NULL \(category_id\)/);
  assert.doesNotMatch(sql, /ON DELETE SET NULL;/);
});
