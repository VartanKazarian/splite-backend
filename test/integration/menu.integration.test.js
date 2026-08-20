const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');

const createProduct = (restaurantId, { name, price = '1000', currency = 'VES', active = true }) =>
  db.query(
    `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, price_minor_units, currency, active`,
    [restaurantId, name, price, currency, active]
  ).then(r => r.rows[0]);

describe('menu products against a real Postgres', { skip }, () => {
  let restaurant;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Menu Tenant' });
  });

  after(async () => {
    if (restaurant) await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  it('defaults a restaurant to a VES menu', async () => {
    const { rows } = await db.query('SELECT menu_currency FROM restaurants WHERE id = $1', [restaurant.id]);
    assert.equal(rows[0].menu_currency, 'VES');
  });

  it('refuses a menu currency outside the supported set', async () => {
    await assert.rejects(
      () => db.query('UPDATE restaurants SET menu_currency = $1 WHERE id = $2', ['GBP', restaurant.id]),
      err => {
        assert.equal(err.code, '23514', 'check_violation');
        return true;
      }
    );
  });

  it('refuses two products with the same name in one restaurant', async () => {
    await createProduct(restaurant.id, { name: 'Arepa' });
    await assert.rejects(
      () => createProduct(restaurant.id, { name: 'Arepa' }),
      err => {
        assert.equal(err.code, '23505', 'unique_violation');
        return true;
      }
    );
  });

  it('allows the same product name in a different restaurant', async () => {
    const other = await fixtures.createRestaurant({ name: 'Other Menu Tenant' });
    try {
      // The uniqueness is per tenant, not global.
      const product = await createProduct(other.id, { name: 'Arepa' });
      assert.ok(product.id);
    } finally {
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [other.id]);
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('refuses a negative price at the database level', async () => {
    await assert.rejects(
      () => createProduct(restaurant.id, { name: 'Impossible', price: '-1' }),
      err => {
        assert.equal(err.code, '23514');
        return true;
      }
    );
  });

  it('keeps prices exact beyond 2^53 minor units', async () => {
    const price = '9007199254740993';
    const product = await createProduct(restaurant.id, { name: 'Very Expensive', price });
    assert.equal(product.price_minor_units, price, 'pg returns BIGINT as a string, intact');
  });

  it('maintains updated_at through the database trigger', async () => {
    const product = await createProduct(restaurant.id, { name: 'Trigger Test' });
    const initial = await db.query('SELECT updated_at FROM menu_products WHERE id = $1', [product.id]);

    await db.query('UPDATE menu_products SET active = false WHERE id = $1', [product.id]);
    const updated = await db.query('SELECT updated_at FROM menu_products WHERE id = $1', [product.id]);

    // 002_phase1_hardening moved this off the call sites; a new table has to
    // actually be wired to the same trigger rather than just claim to be.
    assert.ok(updated.rows[0].updated_at > initial.rows[0].updated_at, 'updated_at advanced without the caller setting it');
  });

  it('removes a restaurant\'s products when the restaurant goes', async () => {
    const doomed = await fixtures.createRestaurant({ name: 'Doomed Menu Tenant' });
    await createProduct(doomed.id, { name: 'Ephemeral' });

    await fixtures.destroyRestaurant(doomed.id);

    const { rows } = await db.query('SELECT count(*)::int AS n FROM menu_products WHERE restaurant_id = $1', [doomed.id]);
    assert.equal(rows[0].n, 0, 'ON DELETE CASCADE covers the menu');
  });
});
