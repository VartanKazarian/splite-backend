const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { paymentHistory } = require('../../src/services/paymentHistory');

/**
 * The week of payments behind the Pagos screen.
 *
 * Rows are inserted directly with chosen timestamps: the window and the paging
 * are the things under test, and both are about *when* a payment happened.
 */
describe('payment history', { skip }, () => {
  let restaurant;
  let bill;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: `Hist ${Date.now()}` });
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM bills WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM tables WHERE restaurant_id = $1', [restaurant.id]);
    const table = await fixtures.createTable(restaurant.id, { name: 'H1' });
    bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 1000000, totalDueVes: 1000000
    });
  });

  const pay = (daysAgo, { amount = 1000, tip = 0, status = 'SUCCEEDED', method = 'CASH' } = {}) =>
    db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method, payer_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'STAFF', now() - make_interval(secs => $7::double precision))`,
      [restaurant.id, bill.id, amount, tip, status, method, daysAgo * 86400]
    );

  it('defaults to seven days and widens on request', async () => {
    await pay(1, { amount: 1000 });
    await pay(6.5, { amount: 2000 });
    await pay(10, { amount: 4000 });
    await pay(40, { amount: 8000 });

    const week = await paymentHistory({ restaurantId: restaurant.id });
    assert.equal(week.days, 7);
    assert.deepEqual(week.data.map(r => r.amountVes), ['1000', '2000']);

    const month = await paymentHistory({ restaurantId: restaurant.id, days: 30 });
    assert.deepEqual(month.data.map(r => r.amountVes), ['1000', '2000', '4000']);

    const quarter = await paymentHistory({ restaurantId: restaurant.id, days: 90 });
    assert.equal(quarter.data.length, 4);
    assert.equal(quarter.data[0].tableName, 'H1');
  });

  it('totals the whole window, succeeded money only', async () => {
    await pay(1, { amount: 1000, tip: 100 });
    await pay(2, { amount: 2000, tip: 200 });
    await pay(3, { amount: 5000, tip: 500, status: 'FAILED', method: 'CARD' });

    const page = await paymentHistory({ restaurantId: restaurant.id, limit: 1 });
    assert.equal(page.data.length, 1);
    assert.equal(page.totals.count, 3);
    assert.equal(page.totals.succeededCount, 2);
    assert.equal(page.totals.succeededVes, '3000');
    assert.equal(page.totals.tipVes, '300');
  });

  it('pages backwards without repeating or skipping a row', async () => {
    for (let i = 0; i < 7; i++) await pay(i * 0.5 + 0.1, { amount: 1000 + i });
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = await paymentHistory({ restaurantId: restaurant.id, cursor, limit: 3 });
      seen.push(...page.data.map(r => r.amountVes));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['1000', '1001', '1002', '1003', '1004', '1005', '1006']);
  });

  it('treats an unreadable cursor as the first page', async () => {
    await pay(1);
    const page = await paymentHistory({ restaurantId: restaurant.id, cursor: 'not-a-cursor' });
    assert.equal(page.data.length, 1);
  });

  it('never shows another restaurant\'s payments', async () => {
    const other = await fixtures.createRestaurant({ name: `Hist other ${Date.now()}` });
    try {
      const table = await fixtures.createTable(other.id, { name: 'X1' });
      const otherBill = await fixtures.createBill({ restaurantId: other.id, tableId: table.id, totalDue: 1000, totalDueVes: 1000 });
      await db.query(
        `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
         VALUES ($1, $2, 999, 'SUCCEEDED', 'CASH', 'STAFF')`, [other.id, otherBill.id]);
      const page = await paymentHistory({ restaurantId: restaurant.id });
      assert.equal(page.data.length, 0);
      assert.equal(page.totals.count, 0);
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
