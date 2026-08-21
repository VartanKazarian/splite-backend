const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { serviceSnapshot, activitySince } = require('../../src/services/dashboard');
const { processSplitPayment } = require('../../src/services/locks');
const claims = require('../../src/services/paymentClaims');

/**
 * What staff see when they look at the room.
 *
 * The assertions that matter are arithmetic. A dashboard exists to be believed,
 * and the figures on it are sums over the same ledger the bills are settled
 * from -- so each one is checked against rows this test put there, not against
 * a shape.
 */
describe('the service dashboard', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => { restaurant = await fixtures.createRestaurant({ name: `Dash ${Date.now()}` }); });

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
  });

  const openBill = async (total = 10000) => {
    const table = await fixtures.createTable(restaurant.id, { name: `D${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: total, totalDueVes: total
    });
    return { table, bill };
  };

  it('counts the room: occupied, free, and what it still owes', async () => {
    const a = await openBill(10000);
    await openBill(6000);
    await fixtures.createTable(restaurant.id, { name: `D${++seq}` }); // free

    // Part-pay one bill, so paid and outstanding are not the same figure.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: a.bill.id, amountPaidMinorUnits: 2500
    });

    const snap = await serviceSnapshot({ restaurantId: restaurant.id });

    assert.equal(snap.tables.total, 3);
    assert.equal(snap.tables.occupied, 2);
    assert.equal(snap.tables.free, 1);
    assert.equal(snap.openBills.totalDueVes, '16000');
    assert.equal(snap.openBills.amountPaidVes, '2500');
    // The number a manager reads first, and the one a client would otherwise
    // have to compute by subtracting two strings.
    assert.equal(snap.openBills.outstandingVes, '13500');
    assert.ok(snap.openBills.oldestOpenedAt, 'the room has been open since something');
  });

  it('adds up the day\'s takings and tips from the ledger', async () => {
    const { bill } = await openBill(20000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000, tipVes: '700'
    });
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 3000, tipVes: '300'
    });

    const snap = await serviceSnapshot({ restaurantId: restaurant.id });
    assert.equal(snap.taken.paymentsVes, '8000');
    assert.equal(snap.taken.tipsVes, '1000');
    assert.equal(snap.taken.payments, 2);
  });

  it('counts a declared payment as waiting, not as taken', async () => {
    // The distinction the whole claims rail exists for: a diner saying they
    // paid is not money, and a dashboard that showed it as takings would be
    // telling a restaurant it had been paid when nobody had checked.
    const { bill } = await openBill(9000);
    await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '9000',
      reference: String(Date.now()).slice(-12), payer: { type: 'GUEST', id: null }
    });

    const snap = await serviceSnapshot({ restaurantId: restaurant.id });
    assert.equal(snap.claims.pending, 1);
    assert.equal(snap.taken.paymentsVes, '0', 'declared is not taken');
    assert.equal(snap.openBills.outstandingVes, '9000', 'and the bill still owes it');
  });

  it('reports the C2P states only a person can end', async () => {
    const { bill } = await openBill(5000);
    await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
       VALUES ($1, $2, 5000, 'IN_DOUBT', 'C2P', 'GUEST')`,
      [restaurant.id, bill.id]
    );

    const snap = await serviceSnapshot({ restaurantId: restaurant.id });
    assert.equal(snap.unresolvedC2P.inDoubt, 1);
    assert.equal(snap.unresolvedC2P.ambiguous, 0);
  });

  it('does not show another restaurant its neighbour\'s room', async () => {
    const other = await fixtures.createRestaurant({ name: `Dash other ${Date.now()}` });
    try {
      const table = await fixtures.createTable(other.id, { name: 'X1' });
      await fixtures.createBill({
        restaurantId: other.id, tableId: table.id, totalDue: 99999, totalDueVes: 99999
      });

      const mine = await serviceSnapshot({ restaurantId: restaurant.id });
      assert.equal(mine.tables.total, 0);
      assert.equal(mine.openBills.totalDueVes, '0');
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  // --- Activity -----------------------------------------------------------

  it('reports a settlement and a declaration differently', async () => {
    const settled = await openBill(10000);
    const declared = await openBill(4000);

    await processSplitPayment({
      restaurantId: restaurant.id, billId: settled.bill.id, amountPaidMinorUnits: 1000, tipVes: '100'
    });
    await claims.declareClaim({
      restaurantId: restaurant.id, billId: declared.bill.id, amountVes: '4000',
      reference: String(Date.now()).slice(-12), payer: { type: 'GUEST', id: null }
    });

    const feed = await activitySince({ restaurantId: restaurant.id });
    const kinds = feed.data.map(e => e.kind).sort();
    assert.deepEqual(kinds, ['DECLARED', 'SETTLED']);

    const paid = feed.data.find(e => e.kind === 'SETTLED');
    assert.equal(paid.amountVes, '1000');
    assert.equal(paid.tipVes, '100');
    // The table name is what a person reads; an id is not something anybody
    // recognises across a dining room.
    assert.equal(paid.tableName, settled.table.name);
  });

  it('returns only what happened after the cursor', async () => {
    // The property a poll depends on. Without it a dashboard re-renders the
    // same payment every few seconds and staff learn to ignore it.
    const { bill } = await openBill(10000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 1000
    });

    const first = await activitySince({ restaurantId: restaurant.id });
    assert.equal(first.data.length, 1);

    const second = await activitySince({ restaurantId: restaurant.id, since: first.asOf });
    assert.equal(second.data.length, 0, 'nothing new since the last look');

    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 2000
    });
    const third = await activitySince({ restaurantId: restaurant.id, since: first.asOf });
    assert.equal(third.data.length, 1, 'and the new one appears exactly once');
    assert.equal(third.data[0].amountVes, '2000');
  });

  it('orders oldest first, so a client can keep the last one as its cursor', async () => {
    const { bill } = await openBill(20000);
    for (const amount of [1000, 2000, 3000]) {
      await processSplitPayment({
        restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: amount
      });
    }

    const feed = await activitySince({ restaurantId: restaurant.id });
    assert.deepEqual(feed.data.map(e => e.amountVes), ['1000', '2000', '3000']);
  });
});
