const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');

/**
 * Migration 004 is the only guarantee that survives an application bug or a
 * direct database write, so it is tested against Postgres rather than through
 * the route.
 */
describe('one open bill per table', { skip }, () => {
  let restaurant;
  let table;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Open Bill Tenant' });
    table = await fixtures.createTable(restaurant.id);
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  it('refuses a second OPEN bill for the same table', async () => {
    await fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 1000 });

    await assert.rejects(
      () => fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 2000 }),
      err => {
        assert.equal(err.code, '23505', 'unique_violation');
        assert.match(String(err.constraint), /one_open_per_table/);
        return true;
      }
    );
  });

  it('frees the table once the bill leaves OPEN', async () => {
    const { rows } = await db.query(
      "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
      [restaurant.id, table.id]
    );
    await db.query("UPDATE bills SET status = 'CLOSED', amount_paid_ves = total_due_ves WHERE id = $1", [rows[0].id]);

    // A partial index only covers status = 'OPEN', so closing releases the slot
    // while the closed bill stays on the table's history.
    const next = await fixtures.createBill({
      restaurantId: restaurant.id,
      tableId: table.id,
      totalDue: 3000
    });
    assert.ok(next.id);

    const all = await db.query(
      'SELECT count(*)::int AS n FROM bills WHERE restaurant_id = $1 AND table_id = $2',
      [restaurant.id, table.id]
    );
    assert.equal(all.rows[0].n, 2, 'the closed bill is retained');
  });

  it('allows different tables to hold open bills simultaneously', async () => {
    const second = await fixtures.createTable(restaurant.id, { name: 'T2' });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id,
      tableId: second.id,
      totalDue: 500
    });
    assert.ok(bill.id, 'the invariant is per table, not per restaurant');
  });

  it('refuses a bill pointing at another restaurant\'s table', async () => {
    const other = await fixtures.createRestaurant({ name: 'Other Tenant' });
    try {
      const otherTable = await fixtures.createTable(other.id);

      // bills.table_id alone was already a foreign key, but nothing tied the
      // two restaurant_id columns together until migration 004.
      await assert.rejects(
        () => db.query(
          `INSERT INTO bills (restaurant_id, table_id, total_due, currency,
                              total_due_ves, fx_rate_ves_per_unit, fx_rate_source)
           VALUES ($1, $2, $3, 'VES', $3, 1, 'IDENTITY')`,
          [restaurant.id, otherTable.id, '100']
        ),
        err => {
          assert.equal(err.code, '23503', 'foreign_key_violation');
          return true;
        }
      );
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
