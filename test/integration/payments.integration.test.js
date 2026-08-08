const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { processSplitPayment } = require('../../src/services/locks');

describe('payments against a real Postgres', { skip }, () => {
  let restaurant;
  let tableSeq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant();
  });

  /**
   * A bill on a table of its own.
   *
   * Migration 004 allows a table only one OPEN bill, and most cases here leave
   * their bill open, so sharing one table would make the second insert collide
   * with the invariant rather than exercise the payment path.
   */
  const freshBill = async (overrides = {}) => {
    const table = await fixtures.createTable(restaurant.id, { name: `T${++tableSeq}` });
    return fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, ...overrides });
  };

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  it('serialises concurrent splits so a bill cannot be overpaid', async () => {
    const bill = await freshBill({ totalDue: 10000 });

    // Five diners tap "pay my share" at once. Only three 3000-unit payments
    // fit inside a 10000 bill; the rest must be rejected, not clamped.
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        processSplitPayment({
          restaurantId: restaurant.id,
          billId: bill.id,
          amountPaidMinorUnits: 3000
        })
      )
    );

    const succeeded = attempts.filter(a => a.status === 'fulfilled');
    const rejected = attempts.filter(a => a.status === 'rejected');

    assert.equal(succeeded.length, 3, 'exactly three payments fit inside the total');
    assert.equal(rejected.length, 2);
    for (const failure of rejected) {
      assert.equal(failure.reason.statusCode, 409);
    }

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid, '9000');
    assert.equal(stored.status, 'OPEN', 'a partially paid bill stays open');
  });

  it('closes the bill when concurrent payments land exactly on the total', async () => {
    const bill = await freshBill({ totalDue: 9000 });

    const attempts = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        processSplitPayment({
          restaurantId: restaurant.id,
          billId: bill.id,
          amountPaidMinorUnits: 3000
        })
      )
    );

    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 3);

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid, '9000');
    assert.equal(stored.status, 'CLOSED');
  });

  it('enforces the overpayment ceiling in the database, not only in the service', async () => {
    const bill = await freshBill({ totalDue: 5000 });

    // Migration 002 adds CHECK (amount_paid <= total_due). Bypassing the
    // service entirely must still be refused, so an application bug or a
    // manual query cannot produce an overpaid row.
    await assert.rejects(
      () => db.query('UPDATE bills SET amount_paid = $1 WHERE id = $2', ['5001', bill.id]),
      err => {
        assert.equal(err.code, '23514', 'check_violation');
        return true;
      }
    );

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid, '0');
  });

  it('keeps amounts exact beyond 2^53 minor units', async () => {
    // Number.MAX_SAFE_INTEGER is 9007199254740991. VES minor units reach this
    // range, and pg returns BIGINT as a string for exactly this reason.
    const totalDue = '9007199254740993';
    const bill = await freshBill({ totalDue });

    const result = await processSplitPayment({
      restaurantId: restaurant.id,
      billId: bill.id,
      amountPaidMinorUnits: 1
    });

    assert.equal(result.totalDue, totalDue);
    assert.equal(result.amountPaid, '1');
    assert.equal(result.remaining, '9007199254740992');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.total_due, totalDue, 'the total survives the round trip intact');
  });

  it('reads a bill from another restaurant as 404', async () => {
    const other = await fixtures.createRestaurant({ name: 'Other Tenant' });
    try {
      const otherTable = await fixtures.createTable(other.id);
      const otherBill = await fixtures.createBill({
        restaurantId: other.id,
        tableId: otherTable.id,
        totalDue: 1000
      });

      await assert.rejects(
        () => processSplitPayment({
          restaurantId: restaurant.id, // caller's tenant, someone else's bill
          billId: otherBill.id,
          amountPaidMinorUnits: 100
        }),
        err => {
          assert.equal(err.statusCode, 404);
          return true;
        }
      );

      const stored = await fixtures.readBill(otherBill.id);
      assert.equal(stored.amount_paid, '0', 'the other tenant\'s bill is untouched');
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('locks one display rate for the whole split, even under concurrency', async () => {
    const bill = await freshBill({ totalDue: 9000 });

    // Each diner's request resolves a slightly different rate, as it would
    // across a real dinner. The first payment to commit must win, and every
    // later split must reuse that value rather than its own.
    let nth = 0;
    const rates = [756.71, 757.04, 757.88];
    const attempts = await Promise.all(
      Array.from({ length: 3 }, () =>
        processSplitPayment({
          restaurantId: restaurant.id,
          billId: bill.id,
          amountPaidMinorUnits: 3000,
          getRate: async () => ({ rate: rates[nth++ % rates.length], source: 'TEST' })
        })
      )
    );

    const locked = new Set(attempts.map(a => a.fxRate));
    assert.equal(locked.size, 1, 'all splits report the same locked rate');
    assert.ok(rates.includes(Number([...locked][0])));

    const { rows } = await db.query('SELECT fx_rate, fx_source, fx_locked_at FROM bills WHERE id = $1', [bill.id]);
    assert.equal(Number(rows[0].fx_rate), Number([...locked][0]));
    assert.equal(rows[0].fx_source, 'TEST');
    assert.ok(rows[0].fx_locked_at, 'fx_locked_at is stamped on first payment');
  });

  it('applies a payment even when no rate is available', async () => {
    const bill = await freshBill({ totalDue: 5000 });

    // An FX outage is presentational. Money must still move.
    const result = await processSplitPayment({
      restaurantId: restaurant.id,
      billId: bill.id,
      amountPaidMinorUnits: 2500,
      getRate: async () => null
    });

    assert.equal(result.amountPaid, '2500');
    assert.equal(result.fxRate, null);
    assert.equal(result.usdReference.remaining, null);

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid, '2500');
  });

  it('refuses a non-VES bill currency at the database level', async () => {
    // Migration 003 constrains settlement to VES.
    await assert.rejects(
      () => freshBill({ totalDue: 1000, currency: 'USD' }),
      err => {
        assert.equal(err.code, '23514', 'check_violation');
        return true;
      }
    );
  });
});
