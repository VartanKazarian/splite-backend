const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const claims = require('../../src/services/paymentClaims');

/**
 * Bill first, then the payment (R18, `src/services/lockOrder.js`).
 *
 * Each test plays "the till": a transaction that takes the bill, as every
 * money path does, and then needs the claim's payment row. Confirming or
 * rejecting the claim starts at the same moment. In the old order the claim
 * side took the payment and then queued for the bill, each holding what the
 * other wanted, and Postgres ended it by killing one of them -- a 500 on
 * somebody's screen. In the new order the claim side waits for the bill
 * holding nothing, so the till finishes and then the claim does.
 */
describe('money paths lock the bill before the payment', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Lock Order Tenant' });
  });

  after(async () => {
    if (restaurant) {
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
  });

  const pendingClaim = async () => {
    const table = await fixtures.createTable(restaurant.id, { name: `LO${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 20000, totalDueVes: 20000
    });
    const claim = await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '5000',
      reference: String(Date.now() + seq).slice(-10)
    });
    return { bill, claim };
  };

  /** Until some other connection is waiting on a lock `pid` holds. */
  const waitUntilBlockedBy = async pid => {
    for (let i = 0; i < 200; i++) {
      const { rowCount } = await db.query(
        'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
      if (rowCount > 0) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('the claim never queued behind the till');
  };

  const raceTheTill = async (bill, claim, act) => {
    const till = await db.getClient();
    try {
      await till.query('BEGIN');
      await till.query('SELECT 1 FROM bills WHERE id = $1 FOR UPDATE', [bill.id]);
      const pid = (await till.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      // Swallowed here and inspected below, so a deadlock on this side shows
      // up as the assertion rather than as an unhandled rejection.
      const settled = act().then(value => ({ value }), error => ({ error }));
      await waitUntilBlockedBy(pid);

      // The till now needs the payment. If the claim side were holding it,
      // this is the statement Postgres would kill as a deadlock.
      await till.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE', [claim.id]);
      await till.query('COMMIT');

      const outcome = await settled;
      assert.equal(outcome.error, undefined, `the claim side failed: ${outcome.error?.message}`);
      return outcome.value;
    } catch (err) {
      await till.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      till.release();
    }
  };

  it('confirming a claim waits for the bill instead of deadlocking', async () => {
    const { bill, claim } = await pendingClaim();
    const result = await raceTheTill(bill, claim, () =>
      claims.confirmClaim({ restaurantId: restaurant.id, claimId: claim.id, actor: { id: null } }));
    assert.equal(result.paymentId, claim.id);
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '5000');
  });

  it('rejecting a claim waits for the bill instead of deadlocking', async () => {
    const { bill, claim } = await pendingClaim();
    await raceTheTill(bill, claim, () =>
      claims.rejectClaim({ restaurantId: restaurant.id, claimId: claim.id, actor: { id: null } }));
    const { rows } = await db.query('SELECT status FROM payments WHERE id = $1', [claim.id]);
    assert.equal(rows[0].status, 'FAILED');
  });
});
