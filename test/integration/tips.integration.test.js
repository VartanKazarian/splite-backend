const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { processSplitPayment } = require('../../src/services/locks');
const { createC2PPayment } = require('../../src/services/mercantilC2P');
const { tipsReport, tipsForBill } = require('../../src/services/tips');

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
    const cash = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000, tipVes: '1000'
    });
    await db.query("UPDATE payments SET payment_method = 'CASH' WHERE id = $1", [cash.paymentId]);
    // Electronic: landed in the restaurant's account, owed to staff.
    const card = await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000, tipVes: '2500'
    });
    await db.query("UPDATE payments SET payment_method = 'CARD' WHERE id = $1", [card.paymentId]);
    // A tipless payment must not appear as a zero row.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000
    });

    const to = new Date(Date.now() + 60_000);
    const report = await tipsReport({ restaurantId: restaurant.id, from, to });

    assert.equal(report.totalTipsVes, '3500');
    assert.equal(report.inTillVes, '1000');
    assert.equal(report.owedToStaffVes, '2500');
    assert.deepEqual(
      report.byMethod.map(m => [m.paymentMethod, m.tipsVes]),
      [['CARD', '2500'], ['CASH', '1000']]
    );
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
    await db.query('UPDATE payments SET created_at = $2 WHERE id = $1', [paymentId, boundary]);

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
