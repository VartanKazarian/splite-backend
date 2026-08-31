const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');

const category = (restaurantId, name, position) =>
  db.query(
    `INSERT INTO menu_categories (restaurant_id, name, position)
     VALUES ($1, $2, $3) RETURNING id, name, position, active`,
    [restaurantId, name, position]
  ).then(r => r.rows[0]);

const product = (restaurantId, name, { categoryId = null, position = 0 } = {}) =>
  db.query(
    `INSERT INTO menu_products
       (restaurant_id, name, price_minor_units, currency, category_id, position)
     VALUES ($1, $2, '1000', 'VES', $3, $4)
     RETURNING id, name, category_id, position`,
    [restaurantId, name, categoryId, position]
  ).then(r => r.rows[0]);

/**
 * Menu sections, against a real Postgres.
 *
 * The constraint behaviour here is the whole reason this file exists: a
 * composite foreign key and its ON DELETE action cannot be asserted by reading
 * the schema, only by trying to break them.
 */
describe('menu categories against a real Postgres', { skip }, () => {
  let mine, theirs;

  before(async () => {
    mine = await fixtures.createRestaurant({ name: 'Categories Tenant' });
    theirs = await fixtures.createRestaurant({ name: 'Other Tenant' });
  });

  after(async () => {
    for (const r of [mine, theirs]) {
      if (!r) continue;
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM menu_categories WHERE restaurant_id = $1', [r.id]);
      await fixtures.destroyRestaurant(r.id);
    }
    await db.close();
  });

  it('refuses two sections with the same name in one restaurant', async () => {
    await category(mine.id, 'Entradas', 0);
    await assert.rejects(
      () => category(mine.id, 'Entradas', 1),
      err => {
        assert.equal(err.code, '23505', 'unique_violation');
        return true;
      }
    );
  });

  it('lets two restaurants each have a section of the same name', async () => {
    const other = await category(theirs.id, 'Entradas', 0);
    assert.ok(other.id);
  });

  it('refuses a product filed under another restaurant\'s section', async () => {
    // The point of the composite key. A plain REFERENCES menu_categories(id)
    // would accept this: the id exists, and nothing would say whose it is.
    const foreign = await db.query(
      'SELECT id FROM menu_categories WHERE restaurant_id = $1 LIMIT 1', [theirs.id]
    );
    await assert.rejects(
      () => product(mine.id, 'Stolen', { categoryId: foreign.rows[0].id }),
      err => {
        assert.equal(err.code, '23503', 'foreign_key_violation');
        return true;
      }
    );
  });

  it('deleting a section leaves its food, uncategorised and still sellable', async () => {
    const postres = await category(mine.id, 'Postres', 5);
    const flan = await product(mine.id, 'Flan', { categoryId: postres.id });

    await db.query('DELETE FROM menu_categories WHERE id = $1', [postres.id]);

    const { rows } = await db.query(
      'SELECT restaurant_id, category_id, active FROM menu_products WHERE id = $1', [flan.id]
    );
    assert.equal(rows.length, 1, 'the product must survive its section');
    assert.equal(rows[0].category_id, null);
    assert.equal(rows[0].active, true);
    // The reason ON DELETE SET NULL names its column: unqualified, it would
    // blank this too, taking the tenant off the product.
    assert.equal(rows[0].restaurant_id, mine.id);
  });

  it('orders as the menu reads, with uncategorised last', async () => {
    const r = await fixtures.createRestaurant({ name: 'Ordering Tenant' });
    try {
      const entradas = await category(r.id, 'Entradas', 0);
      const postres = await category(r.id, 'Postres', 1);

      // Deliberately inserted out of order, and named so that alphabetical
      // sorting would produce a different answer from menu order.
      await product(r.id, 'Zzz sin sección');
      await product(r.id, 'Brownie', { categoryId: postres.id, position: 0 });
      await product(r.id, 'Aceitunas', { categoryId: entradas.id, position: 1 });
      await product(r.id, 'Tequeños', { categoryId: entradas.id, position: 0 });

      const { rows } = await db.query(
        `SELECT p.name
           FROM menu_products p
           LEFT JOIN menu_categories c
             ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id
          WHERE p.restaurant_id = $1
          ORDER BY c.position NULLS LAST, c.name NULLS LAST, p.position, p.name`,
        [r.id]
      );

      assert.deepEqual(rows.map(x => x.name), [
        'Tequeños',        // Entradas, position 0
        'Aceitunas',       // Entradas, position 1 -- after Tequeños despite the alphabet
        'Brownie',         // Postres
        'Zzz sin sección'  // no section, last
      ]);
    } finally {
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM menu_categories WHERE restaurant_id = $1', [r.id]);
      await fixtures.destroyRestaurant(r.id);
    }
  });

  it('keeps products that never had a section', async () => {
    // The migration adds a nullable column to a populated table; rows that
    // predate it must remain readable and sellable rather than needing a
    // backfill guess.
    const loose = await product(mine.id, 'Sin categoría');
    const { rows } = await db.query(
      'SELECT category_id, position FROM menu_products WHERE id = $1', [loose.id]
    );
    assert.equal(rows[0].category_id, null);
    assert.equal(rows[0].position, 0);
  });
});
