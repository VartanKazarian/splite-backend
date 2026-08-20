const test = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/connectors/base');
const dto = require('../src/dto');
const { processSplitPayment } = require('../src/services/locks');
const { tipsReport } = require('../src/services/tips');
const {
  splitPaymentSchema, declareClaimSchema, c2pChargeSchema, tipsReportQuerySchema
} = require('../src/middleware/schemas');

/**
 * A tip is money the diner adds on top of their share. The whole design rests
 * on one line: the bill never sees it. `bills.total_due_ves` is what the
 * kitchen charged, and a tip is not part of that, so crediting it would either
 * close a bill that was never fully paid or trip
 * CHECK (amount_paid_ves <= total_due_ves) outright. What follows pins that
 * separation down on both sides -- the bill stays untouched, the ledger and the
 * bank see the full charge.
 */

/**
 * The same in-memory bill the payment suite uses, reduced to what a tip needs:
 * the row the lock reads, the ledger insert, and the balance update.
 */
function stubBill(bill) {
  const payments = [];
  db.query = async () => ({ rows: bill ? [bill] : [] });
  db.withTransaction = async fn => fn({
    query: async (text, params) => {
      const sql = text.trim();
      if (/^INSERT INTO payments/i.test(sql)) {
        const columns = /\(([^)]*)\)\s*VALUES/i.exec(sql)[1]
          .split(',').map(c => c.trim()).filter(Boolean);
        const row = { id: `payment-${payments.length + 1}` };
        columns.forEach((column, i) => { row[column] = params[i]; });
        payments.push(row);
        return { rows: [row] };
      }
      if (/^SELECT/i.test(sql)) return { rows: bill ? [bill] : [] };
      if (/^UPDATE/i.test(sql)) {
        bill.amount_paid_ves = params[0];
        bill.status = params[1];
        return { rowCount: 1 };
      }
      return { rows: [] };
    }
  });
  return payments;
}

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

test('a tip is charged but does not settle the bill', async () => {
  const bill = openBill();
  const payments = stubBill(bill);

  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500, tipVes: '500'
  });

  assert.equal(bill.amount_paid_ves, '2500', 'the tip must not reach the bill balance');
  assert.equal(result.remaining, '7500');
  assert.equal(payments[0].tip_ves, '500', 'the ledger row carries it');
  assert.equal(result.tipVes, '500');
  assert.equal(result.totalChargedVes, '3000', 'what the diner is actually out of pocket');
});

test('a tip cannot close a bill early', async () => {
  const bill = openBill({ amount_paid_ves: '7500' });
  stubBill(bill);

  // 2000 of share plus 500 of tip is 2500 of money moved, but only 2000 of it
  // is the bill's. Counting the tip here would close a bill still owed 500.
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2000, tipVes: '500'
  });

  assert.equal(result.status, 'OPEN');
  assert.equal(result.remaining, '500');
});

test('a tip does not turn a valid final payment into an overpayment', async () => {
  const bill = openBill({ amount_paid_ves: '9000' });
  stubBill(bill);

  // The mirror image of the case above, and the reason the tip is a separate
  // column rather than an addend: a generous tip on the last share must not be
  // refused for exceeding a total it was never part of.
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 1000, tipVes: '99999'
  });

  assert.equal(result.status, 'CLOSED');
  assert.equal(result.totalChargedVes, '100999');
});

test('an omitted tip records zero rather than null', async () => {
  const payments = stubBill(openBill());
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500
  });

  assert.equal(payments[0].tip_ves, '0');
  assert.equal(result.tipVes, '0');
  assert.equal(result.totalChargedVes, '2500');
});

test('tips stay exact beyond 2^53 centimos', async () => {
  stubBill(openBill({ total_due_ves: '9007199254740999', amount_paid_ves: '9007199254740000' }));
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 999, tipVes: '9007199254740993'
  });
  assert.equal(result.totalChargedVes, '9007199254741992');
});

/* --- the report ------------------------------------------------------- */

/** Scripts the grouped rows the report reads, and captures the query it ran. */
function stubReport(rows) {
  const calls = [];
  db.query = async (text, params) => { calls.push({ text, params }); return { rows }; };
  return calls;
}

test('an unrecorded method is reported as unclassified, not guessed', async () => {
  stubReport([
    { payment_method: 'CASH', payments: 1, tips_ves: '1000' },
    { payment_method: 'CARD', payments: 1, tips_ves: '2000' },
    // What the till records when the client does not say how the money came in.
    { payment_method: 'SPLITE', payments: 3, tips_ves: '4000' },
    { payment_method: 'OTHER', payments: 1, tips_ves: '500' }
  ]);

  const out = await tipsReport({
    restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z'
  });

  // Calling these cash would cancel a real debt to staff; calling them
  // electronic would pay out money already sitting in the drawer.
  assert.equal(out.inTillVes, '1000');
  assert.equal(out.owedToStaffVes, '2000');
  assert.equal(out.unclassifiedVes, '4500');
});

test('the three buckets always sum to the total', async () => {
  stubReport([
    { payment_method: 'CASH', payments: 1, tips_ves: '1000' },
    { payment_method: 'C2P', payments: 1, tips_ves: '2000' },
    { payment_method: 'SPLITE', payments: 1, tips_ves: '3000' }
  ]);
  const out = await tipsReport({
    restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z'
  });

  const parts = BigInt(out.inTillVes) + BigInt(out.owedToStaffVes) + BigInt(out.unclassifiedVes);
  assert.equal(parts.toString(), out.totalTipsVes, 'a tip cannot fall between the buckets');
});

test('cash tips are in the till; electronic tips are owed to staff', async () => {
  stubReport([
    { payment_method: 'C2P', payments: 4, tips_ves: '12000' },
    { payment_method: 'CASH', payments: 2, tips_ves: '3000' },
    { payment_method: 'PAGO_MOVIL', payments: 1, tips_ves: '1000' }
  ]);

  const out = await tipsReport({
    restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z'
  });

  assert.equal(out.totalTipsVes, '16000');
  // The distinction the report exists for: 3000 is already in the drawer, the
  // other 13000 landed in the restaurant's bank and has to be handed over.
  assert.equal(out.inTillVes, '3000');
  assert.equal(out.owedToStaffVes, '13000');
  assert.equal(out.currency, 'VES');
});

test('the report counts only settled money', async () => {
  const calls = stubReport([]);
  await tipsReport({ restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' });

  const [{ text }] = calls;
  assert.match(text, /status = 'SUCCEEDED'/, 'a pending claim is not money yet');
  assert.match(text, /tip_ves > 0/);
});

test('the window is half-open so consecutive shifts do not double-count', async () => {
  const calls = stubReport([]);
  await tipsReport({ restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' });

  const [{ text, params }] = calls;
  assert.match(text, /created_at >= \$2/);
  assert.match(text, /created_at\s+<\s+\$3/);
  assert.deepEqual(params.slice(1), ['2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z']);
});

test('an empty period reports zeroes rather than nothing', async () => {
  stubReport([]);
  const out = await tipsReport({
    restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z'
  });
  assert.equal(out.totalTipsVes, '0');
  assert.equal(out.inTillVes, '0');
  assert.equal(out.owedToStaffVes, '0');
  assert.deepEqual(out.byMethod, []);
});

test('report totals stay exact beyond 2^53 centimos', async () => {
  stubReport([
    { payment_method: 'CASH', payments: 1, tips_ves: '9007199254740993' },
    { payment_method: 'C2P', payments: 1, tips_ves: '9007199254740993' }
  ]);
  const out = await tipsReport({
    restaurantId: 'r1', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z'
  });
  assert.equal(out.totalTipsVes, '18014398509481986');
});

/* --- the wire contract ------------------------------------------------ */

const splitPayment = (over = {}) => ({
  billId: '11111111-1111-4111-8111-111111111111',
  amountMinorUnits: '2500',
  currency: 'VES',
  idempotencyKey: 'key-0123456789abcdef',
  ...over
});

const c2pCharge = (over = {}) => ({
  amountVes: '2500', bankCode: '0105', idNumber: 'V12345678',
  phone: '04145551234', clave: '123456', idempotencyKey: 'key-0123456789abcdef', ...over
});

test('a tip is optional on every rail and defaults to zero', () => {
  const split = splitPaymentSchema.validate(splitPayment());
  assert.equal(split.error, undefined);
  assert.equal(split.value.tipMinorUnits, '0');

  const claim = declareClaimSchema.validate({ amountVes: '2500', reference: '123456789012' });
  assert.equal(claim.error, undefined);
  assert.equal(claim.value.tipVes, '0');

  const charge = c2pChargeSchema.validate(c2pCharge());
  assert.equal(charge.error, undefined);
  assert.equal(charge.value.tipVes, '0');
});

test('a zero-padded tip is a tip of nothing, not an invalid amount', async () => {
  // `minorUnits` accepts "00", and the first version compared the string to
  // '0', so a client sending a padded zero had its entire payment rejected as
  // INVALID_AMOUNT over a tip it never meant to leave.
  const payments = stubBill(openBill());
  const result = await processSplitPayment({
    restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500, tipVes: '00'
  });
  assert.equal(payments[0].tip_ves, '0');
  assert.equal(result.totalChargedVes, '2500');
});

test('a tip that is not a number is refused before anything is written', async () => {
  const payments = stubBill(openBill());
  await assert.rejects(
    processSplitPayment({
      restaurantId: 'r1', billId: 'bill-1', amountPaidMinorUnits: 2500, tipVes: 'abc'
    }),
    err => err.statusCode === 400
  );
  assert.equal(payments.length, 0, 'a bad tip must not reach the ledger as a Postgres error');
});

test('the till can say how the money arrived, and defaults to not saying', () => {
  assert.equal(splitPaymentSchema.validate(splitPayment()).value.paymentMethod, 'SPLITE');
  assert.equal(
    splitPaymentSchema.validate(splitPayment({ paymentMethod: 'CASH' })).value.paymentMethod,
    'CASH'
  );
  // Set by the rails that own them; a client naming one here would be claiming
  // a bank movement nobody verified.
  for (const method of ['C2P', 'PAGO_MOVIL', 'BITCOIN']) {
    assert.ok(splitPaymentSchema.validate(splitPayment({ paymentMethod: method })).error, method);
  }
});

test('a tip that is present is carried through as a digit string', () => {
  assert.equal(splitPaymentSchema.validate(splitPayment({ tipMinorUnits: 500 })).value.tipMinorUnits, '500');
  assert.equal(c2pChargeSchema.validate(c2pCharge({ tipVes: '500' })).value.tipVes, '500');
});

test('a negative tip is refused at the edge', () => {
  for (const tip of ['-1', -1, '1.5', 'abc']) {
    assert.ok(splitPaymentSchema.validate(splitPayment({ tipMinorUnits: tip })).error, `accepted ${tip}`);
  }
});

test('the report period must be a real interval', () => {
  const from = '2026-08-01T00:00:00Z';
  assert.ok(tipsReportQuerySchema.validate({ from }).error, 'an open-ended report scans everything');
  assert.ok(tipsReportQuerySchema.validate({ from, to: from }).error, 'a half-open window of zero width');
  assert.ok(!tipsReportQuerySchema.validate({ from, to: '2026-08-02T00:00:00Z' }).error);
});

test('a claim reports the share and the tip separately, and their sum', () => {
  const out = dto.paymentClaim({
    id: 'c1', bill_id: 'b1', amount_ves: '2500', tip_ves: '500',
    status: 'PENDING', payment_method: 'PAGO_MOVIL', declared_reference: '123456789012'
  });

  // Staff verify the sum against the bank app; only the share settles the bill.
  assert.equal(out.amountVes, '2500');
  assert.equal(out.tipVes, '500');
  assert.equal(out.totalPaidVes, '3000');
});

test('a claim from before tips existed reads as untipped', () => {
  const out = dto.paymentClaim({
    id: 'c1', bill_id: 'b1', amount_ves: '2500', status: 'PENDING', payment_method: 'CASH'
  });
  assert.equal(out.tipVes, '0');
  assert.equal(out.totalPaidVes, '2500');
});
