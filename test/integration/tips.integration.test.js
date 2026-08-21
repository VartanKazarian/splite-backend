const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { processSplitPayment } = require('../../src/services/locks');
const { createC2PPayment, resolveC2PPayment } = require('../../src/services/mercantilC2P');
const { MercantilC2PError } = require('../../src/payments/providers/mercantil/c2p');
const { tipsReport, tipsForBill, tipsForServer } = require('../../src/services/tips');

/**
 * Tips against a real Postgres.
 *
 * The unit suite proves the arithmetic; what only a database can show is that
 * the separation actually holds where it is enforced -- the bill's CHECK
 * constraints, the immutability trigger, and the drift view that compares the
 * cached balance against the ledger. Each of those would notice a tip that had
 * leaked into `amount_ves`, and none of them can be stubbed.
 */
describe('tips against a real Postgres', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => { restaurant = await fixtures.createRestaurant({ name: 'Tips Tenant' }); });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const freshBill = async (overrides = {}) => {
    const table = await fixtures.createTable(restaurant.id, { name: `TIP${++seq}` });
    return fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, ...overrides });
  };

  const readPayment = async id => {
    const { rows } = await db.query(
      'SELECT amount_ves, tip_ves, status, payment_method FROM payments WHERE id = $1', [id]
    );
    return rows[0];
  };

  it('records the tip on the payment and leaves the bill balance alone', async () => {
    const bill = await freshBill({ totalDue: 10000, totalDueVes: 10000 });

    const result = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id,
      amountPaidMinorUnits: 2500, tipVes: '500',
      idempotencyKey: `tip-${bill.id}`
    });

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '2500');
    assert.equal(stored.status, 'OPEN');

    const payment = await readPayment(result.paymentId);
    assert.equal(payment.amount_ves, '2500');
    assert.equal(payment.tip_ves, '500');
    assert.equal(result.totalChargedVes, '3000');
  });

  it('a tip on the final share closes the bill without drifting the ledger', async () => {
    const bill = await freshBill({ totalDue: 6000, totalDueVes: 6000 });

    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 3000, tipVes: '1000'
    });
    const last = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 3000, tipVes: '2500'
    });

    assert.equal(last.status, 'CLOSED');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '6000', 'the bill is paid exactly, tips and all');

    // The view sums `amount_ves` against the cached balance. If a tip had been
    // folded into either side, 3500 of drift would appear here.
    const drift = await db.query('SELECT * FROM payment_ledger_drift WHERE bill_id = $1', [bill.id]);
    assert.equal(drift.rows.length, 0, 'tips must be invisible to the ledger reconciliation');

    assert.equal(await tipsForBill({ restaurantId: restaurant.id, billId: bill.id }), '3500');
  });

  it('a generous tip on the closing payment is not an overpayment', async () => {
    const bill = await freshBill({ totalDue: 1000, totalDueVes: 1000 });

    // CHECK (amount_paid_ves <= total_due_ves) is what would reject this if the
    // tip were ever added to the balance. Nothing here relaxes that constraint;
    // the tip simply is not part of what it guards.
    const result = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 1000, tipVes: '50000'
    });

    assert.equal(result.status, 'CLOSED');
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '1000');
    assert.equal((await readPayment(result.paymentId)).tip_ves, '50000');
  });

  it('refuses a negative tip at the column', async () => {
    const bill = await freshBill({ totalDue: 1000, totalDueVes: 1000 });
    await assert.rejects(
      () => db.query(
        `INSERT INTO payments (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method, payer_type)
         VALUES ($1, $2, 100, -1, 'SUCCEEDED', 'CASH', 'STAFF')`,
        [restaurant.id, bill.id]
      ),
      err => err.code === '23514'
    );
  });

  it('a recorded tip cannot be edited afterwards', async () => {
    const bill = await freshBill({ totalDue: 5000, totalDueVes: 5000 });
    const { paymentId } = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 1000, tipVes: '400'
    });

    // A tip a restaurant could quietly reduce after the diner has left is not a
    // tip. The trigger treats it exactly like `amount_ves`.
    await assert.rejects(
      () => db.query('UPDATE payments SET tip_ves = 0 WHERE id = $1', [paymentId]),
      err => /tip_ves is immutable/.test(err.message)
    );

    assert.equal((await readPayment(paymentId)).tip_ves, '400');
  });

  it('C2P charges the share plus the tip while crediting only the share', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });

    const charged = [];
    const bank = {
      async charge({ amountVesMinor }) {
        charged.push(String(amountVesMinor));
        return { status: 'SUCCEEDED', providerPaymentId: null, bankReference: '900000000777' };
      },
      async search() { return []; }
    };

    const result = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '126000', tipVes: '4000',
      payer: { bankCode: '0105', idNumber: 'V12345678', phone: '04145551234', clave: '123456' },
      idempotencyKey: `c2p-tip-${bill.id}`,
      bankClient: bank
    });

    assert.equal(result.status, 'SUCCEEDED');
    // The single figure the diner authorises at their own bank.
    assert.deepEqual(charged, ['130000']);
    assert.equal(result.totalChargedVes, '130000');
    assert.equal(result.tipVes, '4000');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '126000', 'only the share settles the bill');
    assert.equal(stored.status, 'CLOSED');
    assert.equal((await readPayment(result.paymentId)).tip_ves, '4000');
  });

  it('reports the shift, splitting what is in the till from what is owed', async () => {
    const from = new Date();

    const bill = await freshBill({ totalDue: 20000, totalDueVes: 20000 });
    // Cash: already in the drawer.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id,
      amountPaidMinorUnits: 5000, tipVes: '1000', paymentMethod: 'CASH'
    });
    // Electronic: landed in the restaurant's account, owed to staff.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id,
      amountPaidMinorUnits: 5000, tipVes: '2500', paymentMethod: 'CARD'
    });
    // The method left unsaid, which is what the till records by default.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000, tipVes: '400'
    });
    // A tipless payment must not appear as a zero row.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000
    });

    const to = new Date(Date.now() + 60_000);
    const report = await tipsReport({ restaurantId: restaurant.id, from, to });

    assert.equal(report.totalTipsVes, '3900');
    assert.equal(report.inTillVes, '1000');
    assert.equal(report.owedToStaffVes, '2500');
    // Not silently filed as either: paying it out twice and cancelling a real
    // debt are both worse than saying the method was never recorded.
    assert.equal(report.unclassifiedVes, '400');
    assert.deepEqual(
      report.byMethod.map(m => [m.paymentMethod, m.tipsVes]),
      [['CARD', '2500'], ['CASH', '1000'], ['SPLITE', '400']]
    );
  });

  it('resolves a tipped in-doubt charge against the movement the bank actually made', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });

    // The bank never answers the charge, so it lands IN_DOUBT with the diner
    // possibly already debited for share + tip.
    const indeterminate = {
      async charge() { throw new MercantilC2PError('BANK_INDETERMINATE', 'no response'); },
      async search({ amountVesMinor }) {
        searched.push(String(amountVesMinor));
        // The movement the bank holds is the whole debit, not the share.
        return [{
          reference: '900000000123', amountMinor: '130000',
          phoneOrigin: '04145551234', bankOrigin: '0105',
          date: new Date().toISOString(), status: 'COMPLETED'
        }];
      }
    };
    const searched = [];

    const charge = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '126000', tipVes: '4000',
      payer: { bankCode: '0105', idNumber: 'V12345678', phone: '04145551234', clave: '123456' },
      idempotencyKey: `c2p-doubt-tip-${bill.id}`,
      bankClient: indeterminate
    });
    assert.equal(charge.status, 'IN_DOUBT');

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId: charge.paymentId, bankClient: indeterminate
    });

    // Searching on the share alone found nothing, and NO_MATCH on this path
    // ends with the charge written off while the diner stands debited.
    assert.deepEqual(searched, ['130000']);
    assert.equal(out.status, 'SUCCEEDED');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '126000', 'the bill is still credited only its share');
    assert.equal(stored.status, 'CLOSED');
  });

  it('leaves an unconfirmed tip out of the report until the money is real', async () => {
    const from = new Date();
    const bill = await freshBill({ totalDue: 9000, totalDueVes: 9000 });

    // A Pago Móvil the diner says they sent. Counting its tip would have a
    // restaurant hand out cash against a transfer nobody has verified yet.
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method, payer_type)
       VALUES ($1, $2, 9000, 3000, 'PENDING', 'PAGO_MOVIL', 'GUEST') RETURNING id`,
      [restaurant.id, bill.id]
    );

    const to = new Date(Date.now() + 60_000);
    assert.equal((await tipsReport({ restaurantId: restaurant.id, from, to })).totalTipsVes, '0');

    await db.query(
      `INSERT INTO payment_transitions (payment_id, restaurant_id, from_status, to_status, actor_type)
       VALUES ($1, $2, 'PENDING', 'SUCCEEDED', 'STAFF')`,
      [rows[0].id, restaurant.id]
    );
    await db.query("UPDATE payments SET status = 'SUCCEEDED' WHERE id = $1", [rows[0].id]);

    assert.equal((await tipsReport({ restaurantId: restaurant.id, from, to })).totalTipsVes, '3000');
  });

  it('the window excludes its own upper bound so shifts tile', async () => {
    const bill = await freshBill({ totalDue: 4000, totalDueVes: 4000 });
    const { paymentId } = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 4000, tipVes: '700'
    });

    const boundary = new Date('2026-08-15T12:00:00.000Z');
    // The seam is the settlement, so it is the transition that has to sit on
    // it. A platform payment settles at creation, so both move together.
    await db.query('UPDATE payments SET created_at = $2 WHERE id = $1', [paymentId, boundary]);
    await db.query(
      `UPDATE payment_transitions SET created_at = $2
        WHERE payment_id = $1 AND to_status = 'SUCCEEDED'`,
      [paymentId, boundary]
    );

    const earlier = await tipsReport({
      restaurantId: restaurant.id, from: '2026-08-15T00:00:00.000Z', to: boundary
    });
    const later = await tipsReport({
      restaurantId: restaurant.id, from: boundary, to: '2026-08-16T00:00:00.000Z'
    });

    // Exactly one of two consecutive reports may claim a payment on the seam.
    assert.equal(earlier.totalTipsVes, '0');
    assert.equal(later.totalTipsVes, '700');
  });

  it('reports a tip in the shift it was verified in, not the one it was claimed in', async () => {
    // The bug this pins: a diner declares a Pago Movil at 23:50 and a member of
    // staff finds it in the bank app at 00:30. The row is created before
    // midnight and the money becomes real after it. Reporting on creation put
    // the tip in Friday's figures, and Friday's figures are what a restaurant
    // hands cash out against -- so one shift was short and the next was over.
    const bill = await freshBill({ totalDue: 9000, totalDueVes: 9000 });
    const declaredAt = new Date('2026-09-04T23:50:00.000Z');
    const confirmedAt = new Date('2026-09-05T00:30:00.000Z');

    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method, payer_type, created_at)
       VALUES ($1, $2, 9000, 1500, 'PENDING', 'PAGO_MOVIL', 'GUEST', $3) RETURNING id`,
      [restaurant.id, bill.id, declaredAt]
    );
    await db.query(
      `INSERT INTO payment_transitions (payment_id, restaurant_id, from_status, to_status, actor_type, created_at)
       VALUES ($1, $2, 'PENDING', 'SUCCEEDED', 'STAFF', $3)`,
      [rows[0].id, restaurant.id, confirmedAt]
    );
    await db.query("UPDATE payments SET status = 'SUCCEEDED' WHERE id = $1", [rows[0].id]);

    const friday = await tipsReport({
      restaurantId: restaurant.id,
      from: '2026-09-04T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z'
    });
    const saturday = await tipsReport({
      restaurantId: restaurant.id,
      from: '2026-09-05T00:00:00.000Z', to: '2026-09-06T00:00:00.000Z'
    });

    assert.equal(friday.totalTipsVes, '0', 'nothing was owed on Friday: nobody had verified it yet');
    assert.equal(saturday.totalTipsVes, '1500', 'it became real on Saturday, and is owed there');
    assert.equal(saturday.owedToStaffVes, '1500');
  });

  it('a refund after the shift removes the tip from it', async () => {
    // The SUCCEEDED transition still sits inside the window, so the window is
    // not what excludes it -- the payment's current status is. A tip on money
    // that went back to the diner is owed to nobody.
    const bill = await freshBill({ totalDue: 5000, totalDueVes: 5000 });
    const settledAt = new Date('2026-09-10T20:00:00.000Z');

    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method, payer_type, created_at)
       VALUES ($1, $2, 5000, 800, 'SUCCEEDED', 'CARD', 'STAFF', $3) RETURNING id`,
      [restaurant.id, bill.id, settledAt]
    );
    await db.query(
      `INSERT INTO payment_transitions (payment_id, restaurant_id, from_status, to_status, actor_type, created_at)
       VALUES ($1, $2, NULL, 'SUCCEEDED', 'STAFF', $3)`,
      [rows[0].id, restaurant.id, settledAt]
    );

    const window = { from: '2026-09-10T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z' };
    assert.equal((await tipsReport({ restaurantId: restaurant.id, ...window })).totalTipsVes, '800');

    await db.query("UPDATE payments SET status = 'REFUNDED' WHERE id = $1", [rows[0].id]);
    assert.equal((await tipsReport({ restaurantId: restaurant.id, ...window })).totalTipsVes, '0');
  });

  it('attributes a tip to the person the bill belongs to', async () => {
    // The whole point of the column. A pooled figure a manager reads weekly is
    // an accounting line; a number a waiter can see against their own name is
    // the incentive.
    const { rows: staff } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, 'ana@example.com', 'x', 'WAITER') RETURNING id`,
      [restaurant.id]
    );
    const ana = staff[0].id;

    const bill = await freshBill({ totalDue: 10000, totalDueVes: 10000 });
    await db.query('UPDATE bills SET served_by = $2 WHERE id = $1', [bill.id, ana]);

    const from = new Date(Date.now() - 60_000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000, tipVes: '600'
    });
    const to = new Date(Date.now() + 60_000);

    const mine = await tipsForServer({ restaurantId: restaurant.id, userId: ana, from, to });
    assert.equal(mine.tipsVes, '600');
    assert.equal(mine.billedVes, '5000');
    assert.equal(mine.tipRateBps, 1200, '600 on 5000 is 12.00%');
    assert.equal(mine.bills, 1);

    const report = await tipsReport({ restaurantId: restaurant.id, from, to });
    const hers = report.byServer.find(r => r.userId === ana);
    assert.ok(hers, 'and she appears in the shift report');
    assert.equal(hers.email, 'ana@example.com');
  });

  it('a correction moves the tips with it', async () => {
    // Attribution is read through the bill's *current* server rather than
    // snapshotted when the payment settled, so fixing who served a table fixes
    // the money that followed from it. A correction that left yesterday's tips
    // against the wrong name would not be a correction.
    const { rows: staff } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, 'luis@example.com', 'x', 'WAITER'), ($1, 'sofia@example.com', 'x', 'WAITER')
       RETURNING id, email`,
      [restaurant.id]
    );
    const luis = staff.find(u => u.email === 'luis@example.com').id;
    const sofia = staff.find(u => u.email === 'sofia@example.com').id;

    const bill = await freshBill({ totalDue: 8000, totalDueVes: 8000 });
    await db.query('UPDATE bills SET served_by = $2 WHERE id = $1', [bill.id, luis]);

    const from = new Date(Date.now() - 60_000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 4000, tipVes: '400'
    });
    const to = new Date(Date.now() + 60_000);

    assert.equal((await tipsForServer({ restaurantId: restaurant.id, userId: luis, from, to })).tipsVes, '400');

    // The table was really Sofia's.
    await db.query('UPDATE bills SET served_by = $2 WHERE id = $1', [bill.id, sofia]);

    assert.equal((await tipsForServer({ restaurantId: restaurant.id, userId: luis, from, to })).tipsVes, '0');
    assert.equal((await tipsForServer({ restaurantId: restaurant.id, userId: sofia, from, to })).tipsVes, '400');
  });

  it('removing a member of staff clears the attribution and keeps the tenant', async () => {
    // The bug this pins, found by the suite rather than by reading: a plain
    // ON DELETE SET NULL on a *composite* foreign key nulls every referencing
    // column, so deleting a waiter tried to blank bills.restaurant_id too. The
    // NOT NULL on that column turned it into a refusal rather than corruption,
    // which is why the whole suite started failing on a DELETE FROM users.
    //
    // Naming the column -- ON DELETE SET NULL (served_by) -- nulls only the
    // attribution, which was always the intent: somebody who leaves takes their
    // name off the bill and none of the money with it.
    const { rows: staff } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, 'leaver@example.com', 'x', 'WAITER') RETURNING id`,
      [restaurant.id]
    );
    const bill = await freshBill({ totalDue: 3000, totalDueVes: 3000 });
    await db.query('UPDATE bills SET served_by = $2 WHERE id = $1', [bill.id, staff[0].id]);

    await db.query('DELETE FROM users WHERE id = $1', [staff[0].id]);

    const { rows } = await db.query(
      'SELECT restaurant_id, served_by FROM bills WHERE id = $1', [bill.id]
    );
    assert.equal(rows[0].served_by, null, 'the attribution goes');
    assert.equal(rows[0].restaurant_id, restaurant.id, 'the tenant stays');
  });

  it('a bill with no server still counts toward the total', async () => {
    // Bills predating the column have no server and must not pretend to. If
    // they were dropped from the breakdown the parts would stop summing to the
    // total, which is the kind of gap somebody finds while dividing cash.
    const bill = await freshBill({ totalDue: 5000, totalDueVes: 5000 });
    const from = new Date(Date.now() - 60_000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 2000, tipVes: '250'
    });
    const to = new Date(Date.now() + 60_000);

    const report = await tipsReport({ restaurantId: restaurant.id, from, to });
    const unattributed = report.byServer.find(r => r.userId === null);
    assert.ok(unattributed, 'it is reported, not hidden');
    // At least this one, not exactly this one: every other test in this file
    // shares the restaurant and tips on bills with no server, and they land in
    // the same window. An absolute here would be asserting their arithmetic.
    assert.ok(
      BigInt(unattributed.tipsVes) >= 250n,
      `expected the unattributed bucket to include this tip, got ${unattributed.tipsVes}`
    );

    const summed = report.byServer.reduce((acc, r) => acc + BigInt(r.tipsVes), 0n);
    assert.equal(summed.toString(), report.totalTipsVes);
  });

  it('does not report another tenant\'s tips', async () => {
    const other = await fixtures.createRestaurant({ name: 'Other Tips Tenant' });
    try {
      const table = await fixtures.createTable(other.id, { name: 'X1' });
      const bill = await fixtures.createBill({
        restaurantId: other.id, tableId: table.id, totalDue: 3000, totalDueVes: 3000
      });
      const from = new Date(Date.now() - 60_000);
      await processSplitPayment({
        restaurantId: other.id, billId: bill.id, amountPaidMinorUnits: 3000, tipVes: '900'
      });

      const to = new Date(Date.now() + 60_000);
      const mine = await tipsReport({ restaurantId: restaurant.id, from, to });
      assert.ok(!mine.byMethod.some(m => m.tipsVes === '900'));
      assert.equal((await tipsReport({ restaurantId: other.id, from, to })).totalTipsVes, '900');
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
