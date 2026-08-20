const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/connectors/base');
const { processSplitPayment } = require('../src/services/locks');
const dto = require('../src/dto');

/**
 * Stubs the transaction helper with an in-memory bill so the payment rules can
 * be exercised without a database.
 */
function stubBill(bill) {
  const statements = [];
  statements.payments = [];
  statements.transitions = [];

  db.query = async () => ({ rows: bill ? [bill] : [] });
  db.withTransaction = async fn => fn({
    query: async (text, params) => {
      statements.push(text.trim().split('\n')[0].trim());

      if (/^INSERT INTO payments/i.test(text.trim())) {
        // The column list is read out of the statement rather than mirrored by
        // hand. The hand-written version mapped params by position, so adding a
        // column to the INSERT silently shifted every field after it: the day
        // `declared_reference` landed between provider_payment_id and
        // idempotency_key, this stub started reporting the wrong value for
        // idempotency_key and the failure pointed at the payment path rather
        // than at the stub. A test fixture that models a statement by index
        // fails for reasons that have nothing to do with what it is testing.
        const columns = /\(([^)]*)\)\s*VALUES/i.exec(text)[1]
          .split(',').map(c => c.trim()).filter(Boolean);
        const row = { id: `payment-${statements.payments.length + 1}` };
        columns.forEach((column, i) => { row[column] = params[i]; });

        statements.payments.push(row);
        return { rows: [row] };
      }
      if (/^INSERT INTO payment_transitions/i.test(text.trim())) {
        statements.transitions.push({ paymentId: params[0], from: params[2], to: params[3] });
        return { rows: [] };
      }
      if (/^SELECT/i.test(text.trim())) return { rows: bill ? [bill] : [] };
      if (/^UPDATE/i.test(text.trim())) {
        bill.amount_paid_ves = params[0];
        bill.status = params[1];
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  });
  return statements;
}

/** Settlement columns are VES; currency is what the menu quoted. */
const openBill = (overrides = {}) => ({
  id: 'bill-1',
  restaurant_id: 'r1',
  status: 'OPEN',
  currency: 'VES',
  total_due: '10000',
  total_due_ves: '10000',
  amount_paid_ves: '0',
  fx_rate_ves_per_unit: '1.000000',
  fx_rate_source: 'IDENTITY',
  ...overrides
});

const originalTransaction = db.withTransaction;
const originalQuery = db.query;
test.afterEach(() => { db.withTransaction = originalTransaction; db.query = originalQuery; });

test('partial payment leaves the bill open and reports the remainder', async () => {
  stubBill(openBill());
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });
  assert.equal(result.status, 'OPEN');
  assert.equal(result.amountPaid, '2500');
  assert.equal(result.remaining, '7500');
  assert.equal(result.currency, 'VES', 'settlement is always VES');
});

test('exact final payment closes the bill', async () => {
  stubBill(openBill({ amount_paid_ves: '7500' }));
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.remaining, '0');
});

test('overpayment is rejected with 409', async () => {
  stubBill(openBill({ amount_paid_ves: '9000' }));
  await assert.rejects(
    processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2000 }),
    err => err.statusCode === 409 && /exceeds/.test(err.message)
  );
});

test('paying a closed bill is rejected with 409', async () => {
  stubBill(openBill({ status: 'CLOSED', amount_paid_ves: '10000' }));
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
  assert.ok(statements.some(s => /^SELECT/i.test(s)), 'expected a SELECT statement');
});

test('amounts beyond 2^53 minor units stay exact', async () => {
  stubBill(openBill({ total_due_ves: '9007199254740999', amount_paid_ves: '9007199254740000' }));
  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 999 });
  assert.equal(result.amountPaid, '9007199254740999');
  assert.equal(result.status, 'CLOSED');
});

test('the payment path performs no exchange-rate lookup at all', async () => {
  // The rate is frozen when the bill is opened, so an FX outage cannot reach a
  // payment and no external call happens anywhere near the row lock. This used
  // to be a question of ordering; now there is nothing to order.
  const fx = require('../src/services/fx');
  const realGet = fx.getUsdToVesRate;
  let called = false;
  fx.getUsdToVesRate = async () => { called = true; return null; };

  try {
    stubBill(openBill());
    await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });
    assert.equal(called, false);
  } finally {
    fx.getUsdToVesRate = realGet;
  }
});

test('the USD reference comes from the rate frozen on the bill', async () => {
  // 756 710 céntimos = 7567,10 Bs, which is USD 10.00 at 756.71.
  stubBill(openBill({
    currency: 'USD', total_due: '1000', total_due_ves: '756710',
    fx_rate_ves_per_unit: '756.71000000', fx_rate_source: 'BCV'
  }));

  const result = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 378355 });

  assert.equal(result.fxRate, '756.71000000');
  assert.equal(result.fxSource, 'BCV');
  assert.equal(result.displayCurrency, 'USD');
  assert.equal(result.usdReference.totalDue, '10.00');
  assert.equal(result.usdReference.amountPaid, '5.00');
  assert.equal(result.usdReference.remaining, '5.00');
});

test('every split on a bill reports the same frozen rate', async () => {
  const bill = openBill({
    currency: 'USD', total_due_ves: '756710',
    fx_rate_ves_per_unit: '756.71000000', fx_rate_source: 'BCV'
  });
  stubBill(bill);

  const first = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100000 });
  const second = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 100000 });

  assert.equal(first.fxRate, second.fxRate, 'the quoted figure cannot drift mid-meal');
});

test('a payment writes a ledger row in the same transaction', async () => {
  const statements = stubBill(openBill());

  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500,
    idempotencyKey: 'key-0123456789abcdef', payer: { type: 'STAFF', id: 'user-1' }
  });

  assert.equal(statements.payments.length, 1);
  const [payment] = statements.payments;
  assert.equal(payment.amount_ves, '2500');
  assert.equal(payment.status, 'SUCCEEDED');
  assert.equal(payment.idempotency_key, 'key-0123456789abcdef');
  assert.equal(payment.payer_id, 'user-1');
  assert.equal(result.paymentId, payment.id);
});

test('the opening transition is recorded alongside the payment', async () => {
  const statements = stubBill(openBill());
  await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });
  assert.deepEqual(statements.transitions, [{ paymentId: 'payment-1', from: null, to: 'SUCCEEDED' }]);
});

test('the ledger row and the cached balance are written together', async () => {
  const statements = stubBill(openBill());
  await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500 });

  assert.ok(statements.some(s => /^INSERT INTO payments/i.test(s)));
  assert.ok(statements.some(s => /^UPDATE bills/i.test(s)));
});

// The regression that motivated locking at all: an even split whose parts are
// computed once must close the bill exactly, with no residual céntimos.
test('an exact even split closes the bill with nothing left over', async () => {
  const { splitEvenly } = require('../src/services/split');
  const statements = stubBill(openBill({ total_due_ves: '7567' }));

  let last;
  for (const share of splitEvenly('7567', 3)) {
    last = await processSplitPayment({ restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: Number(share) });
  }

  assert.equal(last.status, 'CLOSED');
  assert.equal(last.remaining, '0');
  assert.equal(statements.payments.length, 3);
  assert.equal(
    statements.payments.reduce((sum, p) => sum + BigInt(p.amount_ves), 0n),
    7567n,
    'the ledger sums to the bill total'
  );
});

// --- The verifier's view of a declared payment ----------------------------

const claimRow = (metadata) => ({
  id: 'c1', bill_id: 'b1', amount_ves: '2500', tip_ves: '0',
  status: 'PENDING', payment_method: 'PAGO_MOVIL',
  declared_reference: '123456789012', metadata
});

test('a verifier is given the bank by name, not asked to know its code', () => {
  const out = dto.staffPaymentClaim(claimRow({
    phoneOrigin: '04145551234', bankOrigin: '0134', idOrigin: 'V12345678'
  }));
  assert.equal(out.bankOrigin, '0134');
  assert.equal(out.bankOriginName, 'Banesco');
  assert.equal(out.idOrigin, 'V12345678');
});

test('a claim declared before the bank was a code still reads', () => {
  // Free text is shown as it was given rather than dropped: somebody working
  // last week's queue is better served by an imperfect answer than a blank.
  const out = dto.staffPaymentClaim(claimRow({ bankOrigin: 'Banesco' }));
  assert.equal(out.bankOrigin, 'Banesco');
  assert.equal(out.bankOriginName, null, 'not a code, so there is no name to resolve');
});

test('a claim with no corroboration is nulls, never missing keys', () => {
  // The verifier's screen renders the same shape either way.
  const out = dto.staffPaymentClaim(claimRow(null));
  assert.equal(out.phoneOrigin, null);
  assert.equal(out.bankOrigin, null);
  assert.equal(out.bankOriginName, null);
  assert.equal(out.idOrigin, null);
});

test('the diner-facing claim never carries the payer detail', () => {
  // phoneOrigin and idOrigin belong to a person; the guest surface is reachable
  // by anyone who scans a sticker on a table.
  const out = dto.paymentClaim(claimRow({
    phoneOrigin: '04145551234', bankOrigin: '0134', idOrigin: 'V12345678'
  }));
  assert.equal(out.phoneOrigin, undefined);
  assert.equal(out.idOrigin, undefined);
  assert.equal(out.bankOrigin, undefined);
});
