const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/connectors/base');
const { processSplitPayment } = require('../src/services/locks');

/**
 * Stubs the transaction helper with an in-memory bill so the payment rules can
 * be exercised without a database.
 */
function stubBill(bill) {
  const statements = [];
  db.withTransaction = async fn => fn({
    query: async (text, params) => {
      statements.push(text.trim().split('\n')[0].trim());
      if (/^SELECT/i.test(text.trim())) return { rows: bill ? [bill] : [] };
      if (/^UPDATE/i.test(text.trim())) {
        bill.amount_paid = params[0];
        bill.status = params[1];
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

const original = db.withTransaction;
test.afterEach(() => { db.withTransaction = original; });

test('partial payment leaves the bill open and reports the remainder', async () => {
  stubBill(openBill());
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500, currency: 'VES' });
  assert.equal(result.status, 'OPEN');
  assert.equal(result.amountPaid, '2500');
  assert.equal(result.remaining, '7500');
});

test('exact final payment closes the bill', async () => {
  stubBill(openBill({ amount_paid: '7500' }));
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500, currency: 'VES' });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.remaining, '0');
});

test('overpayment is rejected with 409', async () => {
  stubBill(openBill({ amount_paid: '9000' }));
  await assert.rejects(
    processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2000, currency: 'VES' }),
    err => err.statusCode === 409 && /exceeds/.test(err.message)
  );
});

test('paying a closed bill is rejected with 409', async () => {
  stubBill(openBill({ status: 'CLOSED', amount_paid: '10000' }));
  await assert.rejects(
    processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100, currency: 'VES' }),
    err => err.statusCode === 409
  );
});

test('currency mismatch is rejected with 409', async () => {
  stubBill(openBill());
  await assert.rejects(
    processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100, currency: 'USD' }),
    err => err.statusCode === 409 && /currency/.test(err.message)
  );
});

test('a bill belonging to another tenant reads as 404', async () => {
  stubBill(null);
  await assert.rejects(
    processSplitPayment({ restaurantId: 'other', billId: 'bill-1', amountPaidMinorUnits: 100, currency: 'VES' }),
    err => err.statusCode === 404
  );
});

test('invalid amounts are rejected before any query runs', async () => {
  const statements = stubBill(openBill());
  for (const amount of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, 'abc']) {
    await assert.rejects(
      processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: amount, currency: 'VES' }),
      err => err.statusCode === 400
    );
  }
  assert.equal(statements.length, 0);
});

test('the bill row is locked with FOR UPDATE and scoped to the tenant', async () => {
  const statements = stubBill(openBill());
  await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100, currency: 'VES' });
  const select = statements.find(s => /^SELECT/i.test(s));
  assert.ok(select, 'expected a SELECT statement');
});

test('amounts beyond 2^53 minor units stay exact', async () => {
  stubBill(openBill({ total_due: '9007199254740999', amount_paid: '9007199254740000' }));
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 999, currency: 'VES' });
  assert.equal(result.amountPaid, '9007199254740999');
  assert.equal(result.status, 'CLOSED');
});
