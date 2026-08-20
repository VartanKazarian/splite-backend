const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const claims = require('../../src/services/paymentClaims');
const { unworkedClaims } = require('../../src/services/reconcile');

/**
 * Making an unwatched queue audible.
 *
 * A declared Pago Móvil settles nothing until a person finds it in the bank
 * app, and nothing tells that person a claim arrived. The two things here are
 * the answers to that: a number cheap enough to poll from every screen, and a
 * reconciler line so an ignored queue is noticed even with no screen at all.
 */
describe('the claims queue, made visible', { skip }, () => {
  let restaurant;
  let other;
  let seq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Queue Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Queue Tenant' });
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await fixtures.destroyRestaurant(other?.id);
    await db.close();
  });

  beforeEach(async () => {
    for (const id of [restaurant.id, other.id]) {
      await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [id]);
      await db.query('DELETE FROM payments WHERE restaurant_id = $1', [id]);
    }
  });

  const billFor = async (tenantId, total = 20000) => {
    const table = await fixtures.createTable(tenantId, { name: `Q${++seq}` });
    return fixtures.createBill({ restaurantId: tenantId, tableId: table.id, totalDue: total, totalDueVes: total });
  };

  const declare = async (tenantId, bill, amount = '5000') => claims.declareClaim({
    restaurantId: tenantId, billId: bill.id, amountVes: amount,
    reference: String(Date.now() + seq++).slice(-12),
    payer: { type: 'GUEST', id: null }
  });

  it('an empty queue reports zero rather than nothing', async () => {
    const summary = await claims.claimsSummary({ restaurantId: restaurant.id });
    assert.equal(summary.pending, 0);
    // Null, not 0: there is no oldest claim, and a zero age would read as one
    // that just arrived.
    assert.equal(summary.oldestPendingAt, null);
    assert.equal(summary.oldestPendingAgeSeconds, null);
  });

  it('counts what is waiting and how long the oldest has been', async () => {
    const bill = await billFor(restaurant.id);
    const first = await declare(restaurant.id, bill);
    await declare(restaurant.id, bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '11 minutes' WHERE id = $1", [first.id]);

    const summary = await claims.claimsSummary({ restaurantId: restaurant.id });
    assert.equal(summary.pending, 2);
    // The figure that matters: a count alone cannot tell a claim that arrived
    // ten seconds ago from one nobody has looked at for a quarter of an hour.
    assert.ok(summary.oldestPendingAgeSeconds >= 660, `age was ${summary.oldestPendingAgeSeconds}`);
    assert.ok(summary.oldestPendingAgeSeconds < 700);
  });

  it('a worked claim leaves the queue, whichever way it was worked', async () => {
    const bill = await billFor(restaurant.id);
    const confirmed = await declare(restaurant.id, bill);
    const rejected = await declare(restaurant.id, bill);
    assert.equal((await claims.claimsSummary({ restaurantId: restaurant.id })).pending, 2);

    await claims.confirmClaim({ restaurantId: restaurant.id, claimId: confirmed.id, actor: { id: null } });
    await claims.rejectClaim({
      restaurantId: restaurant.id, claimId: rejected.id, reason: 'Not in the account', actor: { id: null }
    });

    const summary = await claims.claimsSummary({ restaurantId: restaurant.id });
    assert.equal(summary.pending, 0);
    assert.equal(summary.oldestPendingAt, null);
  });

  it('counts only this restaurant, and only declared payments', async () => {
    const mine = await billFor(restaurant.id);
    const theirs = await billFor(other.id);
    await declare(restaurant.id, mine);
    await declare(other.id, theirs);

    // A C2P charge is PENDING too, and belongs to a different queue with a
    // different remedy -- counting it here would send staff to the bank app
    // looking for a transfer nobody sent.
    await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, provider, payer_type)
       VALUES ($1, $2, 5000, 'PENDING', 'C2P', 'MERCANTIL', 'GUEST')`,
      [restaurant.id, mine.id]
    );

    assert.equal((await claims.claimsSummary({ restaurantId: restaurant.id })).pending, 1);
    assert.equal((await claims.claimsSummary({ restaurantId: other.id })).pending, 1);
  });

  it('an index covers the shape the badge asks for', async () => {
    // The endpoint is meant to be polled from every screen in the room, so the
    // query wants an index that answers it directly rather than filtering every
    // PENDING payment in the installation -- migration 007's pending index
    // carries no restaurant column.
    //
    // Seq scan is disabled for the check rather than asserted against: on a
    // test table of a dozen rows the planner rightly reads the whole thing, and
    // a test that failed for that reason would be measuring the fixture, not
    // the schema. What this pins is that the index *can* serve the query --
    // which of the two is cheaper at a given size is Postgres's decision.
    await db.withTransaction(async tx => {
      await tx.query('SET LOCAL enable_seqscan = off');
      const { rows } = await tx.query(
        `EXPLAIN SELECT count(*)::int, min(created_at)
           FROM payments
          WHERE restaurant_id = $1 AND payment_method = 'PAGO_MOVIL' AND status = 'PENDING'`,
        [restaurant.id]
      );
      const plan = rows.map(r => r['QUERY PLAN']).join('\n');
      assert.match(plan, /payments_pending_claims_idx/, `planner chose:\n${plan}`);
    });
  });

  // `unworkedClaims` sweeps the whole installation, like `unresolvedC2P` -- it
  // answers "is anybody working the queues", which is not a per-tenant question.
  // So these compare against a baseline rather than against zero: asserting an
  // absolute count would be asserting what every other suite left behind.
  const unworkedCount = async () => (await unworkedClaims({ olderThanHours: 2 }))?.count ?? 0;

  it('the reconciler stays quiet about a queue that is being worked', async () => {
    const initial = await unworkedCount();
    const bill = await billFor(restaurant.id);
    await declare(restaurant.id, bill);   // fresh: somebody may well be looking at it now

    assert.equal(await unworkedCount(), initial, 'a claim declared seconds ago is not neglect');
  });

  it('the reconciler reports a queue nobody has worked', async () => {
    const initial = await unworkedCount();
    const bill = await billFor(restaurant.id);
    const stale = await declare(restaurant.id, bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '9 hours' WHERE id = $1", [stale.id]);

    const found = await unworkedClaims({ olderThanHours: 2 });
    assert.ok(found, 'a claim from nine hours ago is not "busy tonight"');
    assert.equal(found.count, initial + 1);
    assert.ok(new Date(found.oldest) <= new Date(Date.now() - 8 * 3600 * 1000));
  });
});
