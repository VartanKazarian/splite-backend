const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const reconcile = require('../../src/services/reconcile');
const splits = require('../../src/services/splits');
const { processSplitPayment } = require('../../src/services/locks');

/**
 * The reconciler, against a real Postgres.
 *
 * Both checks are only worth having if they actually fire, so each one here is
 * shown clean first and then shown detecting drift injected behind the write
 * paths -- a direct UPDATE, which is exactly the shape of the bug the views
 * exist to catch (a write path that moved money without maintaining its cache).
 */
describe('reconciliation against a real Postgres', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => { restaurant = await fixtures.createRestaurant(); });
  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const freshBill = async (total = 20000) => {
    const table = await fixtures.createTable(restaurant.id, { name: `R${++seq}` });
    return fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: total, totalDueVes: total });
  };

  /** Drift rows for this test's restaurant only; the suite shares a database. */
  const mine = rows => rows.filter(r => r.restaurant_id === restaurant.id);

  it('a bill settled through the normal path shows no drift', async () => {
    const bill = await freshBill(20000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 20000
    });

    assert.deepEqual(mine(await reconcile.ledgerDrift()), [], 'settling normally keeps the cache true');
  });

  it('detects a bill whose cached paid figure disagrees with its ledger', async () => {
    const bill = await freshBill(20000);
    // The bug shape: money recorded on the bill with no payment behind it.
    await db.query('UPDATE bills SET amount_paid_ves = 5000 WHERE id = $1', [bill.id]);

    const drift = mine(await reconcile.ledgerDrift());
    const row = drift.find(r => r.bill_id === bill.id);
    assert.ok(row, 'the drifted bill is reported');
    assert.equal(row.cached_amount_paid, '5000');
    assert.equal(row.ledger_amount_paid, '0');
    assert.equal(row.difference, '5000');

    // Leave the shared database clean for the other cases.
    await db.query('UPDATE bills SET amount_paid_ves = 0 WHERE id = $1', [bill.id]);
    assert.equal(mine(await reconcile.ledgerDrift()).length, 0);
  });

  it('a share settled through the normal path shows no drift', async () => {
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] },
      createdBy: { type: 'STAFF', id: null }
    });
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id,
      amountPaidMinorUnits: 10000, splitParticipantId: split.participants[0].id
    });

    assert.deepEqual(mine(await reconcile.splitShareDrift()), [],
      'advanceShare keeps the share cache true');
  });

  it('detects a share whose cached paid figure disagrees with the payments citing it', async () => {
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] },
      createdBy: { type: 'STAFF', id: null }
    });
    const share = split.participants[0].id;
    // A share credited without a payment behind it -- what a future refund path
    // that forgot to decrement would look like.
    await db.query('UPDATE bill_split_participants SET amount_paid_ves = 4000 WHERE id = $1', [share]);

    const drift = mine(await reconcile.splitShareDrift());
    const row = drift.find(r => r.participant_id === share);
    assert.ok(row, 'the drifted share is reported');
    assert.equal(row.cached_amount_paid, '4000');
    assert.equal(row.ledger_amount_paid, '0');
    assert.equal(row.difference, '4000');

    await db.query('UPDATE bill_split_participants SET amount_paid_ves = 0 WHERE id = $1', [share]);
    assert.equal(mine(await reconcile.splitShareDrift()).length, 0);
  });

  it('reports ok when nothing is broken, and not ok when something is', async () => {
    const clean = await reconcile.reconcileAll();
    assert.equal(typeof clean.ok, 'boolean');
    assert.ok(Array.isArray(clean.drift.ledger));
    assert.ok(Array.isArray(clean.drift.splitShares));
    assert.ok(Array.isArray(clean.attention.unresolvedC2P));

    const bill = await freshBill(20000);
    await db.query('UPDATE bills SET amount_paid_ves = 1 WHERE id = $1', [bill.id]);
    const dirty = await reconcile.reconcileAll();
    assert.equal(dirty.ok, false, 'a broken invariant is not ok');

    await db.query('UPDATE bills SET amount_paid_ves = 0 WHERE id = $1', [bill.id]);
    // An unresolved-C2P finding is attention, never a failure: IN_DOUBT is a
    // correct state, not a broken one.
    const restored = await reconcile.reconcileAll();
    assert.equal(restored.drift.ledger.filter(r => r.bill_id === bill.id).length, 0);
  });
});
