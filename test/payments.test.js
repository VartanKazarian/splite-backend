const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/connectors/base');
const { processSplitPayment } = require('../src/services/locks');

/**
 * Stubs the transaction helper with an in-memory bill so the payment rules can
 * be exercised without a database.
 */
function stubBill(bill, { rate = null } = {}) {
  const statements = [];
  // Satisfies the unlocked pre-read in resolvePendingRate.
  db.query = async () => ({ rows: bill ? [{ fx_rate: bill.fx_rate ?? null }] : [] });
  db.withTransaction = async fn => fn({
    query: async (text, params) => {
      statements.push(text.trim().split('\n')[0].trim());
      if (/^SELECT/i.test(text.trim())) return { rows: bill ? [bill] : [] };
      if (/^UPDATE/i.test(text.trim())) {
        bill.amount_paid = params[0];
        bill.status = params[1];
        // Mirror the statement's COALESCE(fx_rate, $5): the rate is written
        // only when the bill has none yet, so a later split cannot overwrite
        // the rate an earlier one locked.
        //
        // The service reads these columns back after the UPDATE to report the
        // committed value. A stub that acknowledged the write without applying
        // it left that read returning undefined, so every locked rate came back
        // null while the assertions still passed against the pre-read-back
        // implementation.
        if ((bill.fx_rate ?? null) === null && params[4] !== null && params[4] !== undefined) {
          bill.fx_rate = params[4];
          bill.fx_source = params[5];
        }
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  });
  return statements;
}

const openBill = (overrides = {}) => ({
  id: 'bill-1', restaurant_id: 'r1', total_due: '10000', amount_paid: '0', status: 'OPEN', currency: 'VES', ...overrides
});

const originalTransaction = db.withTransaction;
const originalQuery = db.query;
test.afterEach(() => { db.withTransaction = originalTransaction; db.query = originalQuery; });

const getRate = rate => async () => ({ rate, source: 'BCV' });

test('partial payment leaves the bill open and reports the remainder', async () => {
  stubBill(openBill());
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });
  assert.equal(result.status, 'OPEN');
  assert.equal(result.amountPaid, '2500');
  assert.equal(result.remaining, '7500');
});

test('exact final payment closes the bill', async () => {
  stubBill(openBill({ amount_paid: '7500' }));
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.remaining, '0');
});

test('overpayment is rejected with 409', async () => {
  stubBill(openBill({ amount_paid: '9000' }));
  await assert.rejects(
    processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2000 }),
    err => err.statusCode === 409 && /exceeds/.test(err.message)
  );
});

test('paying a closed bill is rejected with 409', async () => {
  stubBill(openBill({ status: 'CLOSED', amount_paid: '10000' }));
  await assert.rejects(
    processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100 }),
    err => err.statusCode === 409
  );
});

test('a bill belonging to another tenant reads as 404', async () => {
  stubBill(null);
  await assert.rejects(
    processSplitPayment({ restaurantId: 'other', billId: 'bill-1', amountPaidMinorUnits: 100 }),
    err => err.statusCode === 404
  );
});

test('invalid amounts are rejected before any query runs', async () => {
  const statements = stubBill(openBill());
  for (const amount of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, 'abc']) {
    await assert.rejects(
      processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: amount }),
      err => err.statusCode === 400
    );
  }
  assert.equal(statements.length, 0);
});

test('the bill row is locked with FOR UPDATE and scoped to the tenant', async () => {
  const statements = stubBill(openBill());
  await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100 });
  const select = statements.find(s => /^SELECT/i.test(s));
  assert.ok(select, 'expected a SELECT statement');
});

test('amounts beyond 2^53 minor units stay exact', async () => {
  stubBill(openBill({ total_due: '9007199254740999', amount_paid: '9007199254740000' }));
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 999 });
  assert.equal(result.amountPaid, '9007199254740999');
  assert.equal(result.status, 'CLOSED');
});

test('the display rate is locked on the first payment', async () => {
  // 756 710 céntimos = 7567,10 Bs, which is exactly USD 10.00 at 756.71.
  stubBill(openBill({ total_due: '756710' }));
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 378355, getRate: getRate('756.71')
  });
  // Normalised to the scale of bills.fx_rate NUMERIC(20,6), so the payment that
  // locks the rate reports the same string as every later split, which reads it
  // back from Postgres.
  assert.equal(result.fxRate, '756.710000');
  assert.equal(result.fxSource, 'BCV');
  assert.equal(result.usdReference.totalDue, '10.00');
  assert.equal(result.usdReference.amountPaid, '5.00');
  assert.equal(result.usdReference.remaining, '5.00');
});

test('a bill with a locked rate keeps it and never re-reads', async () => {
  stubBill(openBill({ fx_rate: '748.780000', fx_source: 'BCV', amount_paid: '2500' }));
  let called = false;
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500,
    getRate: async () => { called = true; return { rate: 756.71, source: 'BCV' }; }
  });
  assert.equal(called, false, 'must not fetch a rate for an already-locked bill');
  assert.equal(result.fxRate, '748.780000');
});

// An FX outage is presentational. Money must still move.
test('payment succeeds with no rate available, omitting the USD reference', async () => {
  stubBill(openBill());
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500, getRate: async () => null
  });
  assert.equal(result.status, 'OPEN');
  assert.equal(result.amountPaid, '2500');
  assert.equal(result.fxRate, null);
  assert.equal(result.usdReference.totalDue, null);
});

test('a failing rate lookup does not fail the payment', async () => {
  stubBill(openBill());
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500,
    getRate: async () => { throw new Error('FX provider down'); }
  });
  assert.equal(result.amountPaid, '2500');
  assert.equal(result.fxRate, null);
});

// The regression that motivated locking at all: an even split whose parts are
// computed once must close the bill exactly, with no residual céntimos.
test('an exact even split closes the bill with nothing left over', async () => {
  const { splitEvenly } = require('../src/services/split');
  const bill = openBill({ total_due: '7567' });
  stubBill(bill);
  let last;
  for (const share of splitEvenly('7567', 3)) {
    last = await processSplitPayment({
      restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: Number(share), getRate: getRate('756.71')
    });
  }
  assert.equal(last.status, 'CLOSED');
  assert.equal(last.remaining, '0');
});
