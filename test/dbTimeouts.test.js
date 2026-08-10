const { test } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/connectors/base');
const config = require('../src/config');
const { processSplitPayment } = require('../src/services/locks');

const originalTransaction = db.withTransaction;
const originalQuery = db.query;
test.afterEach(() => { db.withTransaction = originalTransaction; db.query = originalQuery; });

/** Captures the options withTransaction is called with. */
function captureTransactionOptions(bill) {
  const seen = { options: null, statements: [] };
  db.query = async () => ({ rows: bill ? [{ fx_rate: bill.fx_rate ?? null }] : [] });
  db.withTransaction = async (fn, options) => {
    seen.options = options;
    return fn({
      query: async (text, params) => {
        seen.statements.push(text.trim().split('\n')[0].trim());
        if (/^INSERT INTO payments/i.test(text.trim())) return { rows: [{ id: 'payment-1' }] };
        if (/^INSERT INTO payment_transitions/i.test(text.trim())) return { rows: [] };
        if (/^SELECT/i.test(text.trim())) return { rows: bill ? [bill] : [] };
        if (/^UPDATE/i.test(text.trim())) {
          bill.amount_paid = params[0];
          bill.status = params[1];
          return { rowCount: 1 };
        }
        return { rows: [] };
      }
    });
  };
  return seen;
}

const openBill = (overrides = {}) => ({
  id: 'bill-1', restaurant_id: 'r1', total_due: '10000', amount_paid: '0',
  status: 'OPEN', currency: 'VES', ...overrides
});

test('the pool sets a server-side statement timeout, not just a connect timeout', () => {
  // connectionTimeoutMillis bounds waiting for a connection; it says nothing
  // about how long a query may then run. Both are needed.
  assert.equal(db.pool.options.connectionTimeoutMillis, config.db.connectionTimeoutMs);
  assert.equal(db.pool.options.statement_timeout, config.db.statementTimeoutMs);
});

test('the pool bounds transactions that stop making progress', () => {
  // Otherwise a stalled transaction holds its row locks until the socket dies.
  assert.equal(
    db.pool.options.idle_in_transaction_session_timeout,
    config.db.idleInTransactionTimeoutMs
  );
});

test('a payment runs on the payment budget, not the default one', async () => {
  const seen = captureTransactionOptions(openBill());

  await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });

  assert.equal(seen.options.statementTimeoutMs, config.db.paymentStatementTimeoutMs);
  assert.notEqual(
    config.db.paymentStatementTimeoutMs,
    config.db.statementTimeoutMs,
    'the payment budget is deliberately not the default'
  );
});

test('the payment budget is the larger of the two', () => {
  // Several diners paying one bill serialise on SELECT ... FOR UPDATE, and the
  // time spent waiting for that lock counts toward statement_timeout.
  assert.ok(
    config.db.paymentStatementTimeoutMs > config.db.statementTimeoutMs,
    'a payment queued behind other diners needs more room than a menu listing'
  );
});

test('the FX lookup happens before the transaction opens', async () => {
  // The slow part of a Venezuelan payment is the external rail, not the SQL.
  // Resolving it inside the transaction would hold a row lock across a network
  // call and make the statement budget a function of somebody else's uptime.
  const order = [];
  const bill = openBill();

  db.query = async () => { order.push('rate-preread'); return { rows: [{ fx_rate: null }] }; };
  db.withTransaction = async (fn) => {
    order.push('begin');
    return fn({
      query: async (text, params) => {
        if (/^INSERT INTO payments/i.test(text.trim())) return { rows: [{ id: 'payment-1' }] };
        if (/^INSERT INTO payment_transitions/i.test(text.trim())) return { rows: [] };
        if (/^SELECT/i.test(text.trim())) return { rows: [bill] };
        if (/^UPDATE/i.test(text.trim())) { bill.amount_paid = params[0]; bill.status = params[1]; return { rowCount: 1 }; }
        return { rows: [] };
      }
    });
  };

  await processSplitPayment({
    restaurantId: 'r1',
    billId: 'bill-1',
    amountPaidMinorUnits: 2500,
    getRate: async () => { order.push('fx-fetch'); return { rate: 757.5406, source: 'BCV' }; }
  });

  assert.deepEqual(
    order.slice(0, 3),
    ['rate-preread', 'fx-fetch', 'begin'],
    'the rate is resolved before BEGIN, never while holding the lock'
  );
});
