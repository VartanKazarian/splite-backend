const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');

/**
 * Tenant integrity in the ledger, enforced by the database.
 *
 * Every write path already re-reads the bill under
 * `WHERE id = $1 AND restaurant_id = $2` before touching it, so the rows below
 * can only be produced by going around the application entirely -- which is
 * exactly the point. Migration 004 made the same argument for bills and tables:
 * a guarantee that depends on every future caller remembering is not a
 * guarantee, and this is the table that holds money.
 */
describe('ledger tenant integrity', { skip }, () => {
  let a;
  let b;

  before(async () => {
    a = await fixtures.createRestaurant({ name: `Tenant A ${Date.now()}` });
    b = await fixtures.createRestaurant({ name: `Tenant B ${Date.now()}` });
  });

  after(async () => {
    await fixtures.destroyRestaurant(a?.id);
    await fixtures.destroyRestaurant(b?.id);
    await db.close();
  });

  // A fresh table per bill: only one bill may be OPEN on a table at a time, so
  // reusing one table would have the second case fail on that index instead of
  // on the constraint under test.
  let tableSeq = 0;
  const billForA = async () => {
    const table = await fixtures.createTable(a.id, { name: `A${++tableSeq}` });
    return fixtures.createBill({ restaurantId: a.id, tableId: table.id, totalDue: 5000 });
  };

  const insertPayment = (restaurantId, billId, status = 'SUCCEEDED') => db.query(
    `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
     VALUES ($1, $2, '5000', $3, 'CASH', 'STAFF') RETURNING id`,
    [restaurantId, billId, status]
  );

  it("refuses a payment naming one restaurant and pointing at another's bill", async () => {
    const bill = await billForA();
    await assert.rejects(
      () => insertPayment(b.id, bill.id),
      err => {
        assert.equal(err.code, '23503', `expected a foreign key violation, got ${err.code}`);
        assert.match(err.constraint, /same_restaurant/);
        return true;
      }
    );
  });

  it("refuses a transition naming one restaurant and pointing at another's payment", async () => {
    const bill = await billForA();
    const { rows } = await insertPayment(a.id, bill.id, 'PENDING');

    await assert.rejects(
      () => db.query(
        `INSERT INTO payment_transitions (payment_id, restaurant_id, from_status, to_status)
         VALUES ($1, $2, 'PENDING', 'SUCCEEDED')`,
        [rows[0].id, b.id]
      ),
      err => err.code === '23503'
    );
  });

  it('still accepts both rows written correctly', async () => {
    // The other half of the assertion: a constraint that rejects everything
    // passes the two tests above and breaks the product.
    const bill = await billForA();
    const { rows } = await insertPayment(a.id, bill.id, 'PENDING');
    await db.query(
      `INSERT INTO payment_transitions (payment_id, restaurant_id, from_status, to_status)
       VALUES ($1, $2, 'PENDING', 'SUCCEEDED')`,
      [rows[0].id, a.id]
    );

    const { rows: check } = await db.query(
      'SELECT count(*)::int AS n FROM payment_transitions WHERE payment_id = $1', [rows[0].id]
    );
    assert.equal(check[0].n, 1);
  });
});
