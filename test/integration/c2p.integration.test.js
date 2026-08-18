const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const {
  createC2PPayment, resolveC2PPayment
} = require('../../src/services/mercantilC2P');
const { MercantilC2PError } = require('../../src/payments/providers/mercantil/c2p');

/**
 * The C2P guarantees that only a real Postgres can show: a charge the bank
 * never confirmed does not touch the bill, a resolution settles inside one
 * transaction, one bank movement settles exactly one payment, and two
 * simultaneous resolves cannot both credit the same charge.
 *
 * The bank itself is injected. Everything under test is ours -- the ledger, the
 * row locks, the unique index -- and the network call is exactly the part that
 * must not run in a test. The matcher's own decisions are covered by the unit
 * suite; here the movements are chosen to drive a known outcome.
 */
describe('Mercantil C2P against a real Postgres', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => { restaurant = await fixtures.createRestaurant(); });
  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const freshBill = async (overrides = {}) => {
    const table = await fixtures.createTable(restaurant.id, { name: `C${++seq}` });
    return fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, ...overrides });
  };

  const payer = (over = {}) => ({
    bankCode: '0105', idNumber: 'V12345678', phone: '04145551234', clave: '123456', ...over
  });

  /** A bank whose charge is indeterminate and whose search returns what it is told. */
  const bank = (movements = []) => ({
    async charge() { throw new MercantilC2PError('BANK_INDETERMINATE', 'no response'); },
    async search() { return movements; }
  });

  const movement = (over = {}) => ({
    reference: '900000000001', amountMinor: '126000',
    phoneOrigin: '04145551234', bankOrigin: '0105',
    date: new Date().toISOString(), status: 'COMPLETED', ...over
  });

  /** A bank that confirms the charge, returning a fixed reference. */
  const confirmingBank = (reference = '900000000555') => ({
    async charge() { return { status: 'SUCCEEDED', providerPaymentId: null, bankReference: reference }; },
    async search() { return []; }
  });

  /** An IN_DOUBT charge, created through the real charge path with a stubbed bank. */
  const inDoubtCharge = async (bill, over = {}) => {
    const result = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '126000',
      payer: payer(over.payer), idempotencyKey: over.key ?? `idem-${seq}-${Math.random().toString(36).slice(2)}`,
      bankClient: bank()
    });
    assert.equal(result.status, 'IN_DOUBT');
    return result;
  };

  it('an indeterminate charge lands IN_DOUBT and does not touch the bill', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const result = await inDoubtCharge(bill);

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '0', 'nothing is settled while in doubt');
    assert.equal(stored.status, 'OPEN');

    const { rows } = await db.query('SELECT status, payment_method, provider FROM payments WHERE id = $1', [result.paymentId]);
    assert.equal(rows[0].status, 'IN_DOUBT');
    assert.equal(rows[0].payment_method, 'C2P');
    assert.equal(rows[0].provider, 'MERCANTIL');
  });

  it('resolves and settles when a movement matches on amount and phone', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);

    // Backdate past the settlement window so a NO_MATCH would fail rather than
    // pend; here it matches, so the window does not gate it, but it keeps the
    // test independent of wall-clock timing.
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId,
      bankClient: bank([movement({ reference: '900000000042' })])
    });

    assert.equal(out.status, 'SUCCEEDED');
    assert.equal(out.bankReference, '900000000042');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '126000');
    assert.equal(stored.status, 'CLOSED');

    const { rows } = await db.query('SELECT provider_payment_id FROM payments WHERE id = $1', [paymentId]);
    assert.equal(rows[0].provider_payment_id, '900000000042', 'the movement is recorded as spent');
  });

  it('goes AMBIGUOUS rather than guessing between two equal movements', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId,
      bankClient: bank([
        movement({ reference: '900000000001', phoneOrigin: '04141111234' }),
        movement({ reference: '900000000002', phoneOrigin: '04145551234' })
      ])
    });

    // Same amount, different references, only one phone match -> the single
    // amount-only case is still ambiguous. Both references are surfaced.
    assert.equal(out.status, 'AMBIGUOUS');
    assert.ok(out.candidateReferences.includes('900000000001'));

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '0', 'ambiguity settles nothing');

    // AMBIGUOUS is terminal for the resolver: asking again returns it unchanged.
    const again = await resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: bank([]) });
    assert.equal(again.status, 'AMBIGUOUS');
    assert.equal(again.alreadyResolved, true);
  });

  it('a movement already spent is not matched to a second charge', async () => {
    // Two tables, identical bills, each with an in-doubt charge. One movement.
    // Resolved in sequence, the consumed-reference lookup keeps the second
    // resolver from even treating the spent movement as a candidate -- the
    // first line of defence, before the unique index is ever reached.
    const billA = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const billB = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const a = await inDoubtCharge(billA);
    const b = await inDoubtCharge(billB);
    // Push B past the settlement window so an unmatched result is a decisive
    // FAILED rather than a pend, which is what proves it did not settle.
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [b.paymentId]);
    const shared = bank([movement({ reference: '900000000777' })]);

    const first = await resolveC2PPayment({ restaurantId: restaurant.id, paymentId: a.paymentId, bankClient: shared });
    assert.equal(first.status, 'SUCCEEDED');

    const second = await resolveC2PPayment({ restaurantId: restaurant.id, paymentId: b.paymentId, bankClient: shared });
    assert.equal(second.status, 'FAILED', 'the spent movement is not matched again');
    assert.equal((await fixtures.readBill(billB.id)).amount_paid_ves, '0', 'the second bill is untouched');
    assert.equal((await fixtures.readBill(billA.id)).amount_paid_ves, '126000', 'the movement settled exactly one bill');
  });

  it('concurrent resolves of one charge settle it only once', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    const shared = bank([movement({ reference: '900000000900' })]);

    const [r1, r2] = await Promise.allSettled([
      resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: shared }),
      resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: shared })
    ]);

    // One resolver settles; the other, blocked on the row lock, wakes to find
    // the charge already SUCCEEDED and reports `alreadyResolved` rather than
    // settling again. Counting real settlements means excluding that echo.
    const realSettlements = [r1, r2].filter(
      r => r.status === 'fulfilled' && r.value.status === 'SUCCEEDED' && !r.value.alreadyResolved
    );
    assert.equal(realSettlements.length, 1, 'the charge settles exactly once');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '126000', 'the bill is credited once, never twice');
    assert.equal(stored.status, 'CLOSED');
  });

  it('two charges racing for one movement never double-spend it', async () => {
    // The case the unique index exists for: two different in-doubt charges
    // resolved at the same instant against the same movement. Both may read the
    // consumed set as empty and both may match -- and then exactly one settles,
    // because provider_payment_id carries a unique index. The loser is either
    // rejected on the index or, if it lost the row-lock race first, declines the
    // now-spent movement. Both are safe; what must never happen is two credits.
    const billA = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const billB = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const a = await inDoubtCharge(billA);
    const b = await inDoubtCharge(billB);
    const shared = bank([movement({ reference: '900000000424' })]);

    const [r1, r2] = await Promise.allSettled([
      resolveC2PPayment({ restaurantId: restaurant.id, paymentId: a.paymentId, bankClient: shared }),
      resolveC2PPayment({ restaurantId: restaurant.id, paymentId: b.paymentId, bankClient: shared })
    ]);

    const settled = [r1, r2].filter(r => r.status === 'fulfilled' && r.value.status === 'SUCCEEDED');
    assert.equal(settled.length, 1, 'the movement settles exactly one of the two charges');

    for (const r of [r1, r2]) {
      if (r.status === 'rejected') {
        assert.equal(r.reason.code, 'PAYMENT_REFERENCE_ALREADY_USED', 'the loser fails on the reference, not obscurely');
      }
    }

    const paidA = (await fixtures.readBill(billA.id)).amount_paid_ves;
    const paidB = (await fixtures.readBill(billB.id)).amount_paid_ves;
    assert.deepEqual([paidA, paidB].sort(), ['0', '126000'], 'exactly one bill is credited');
  });

  it('an unattributable charge past the window fails and frees a retry', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId, bankClient: bank([]) // no movements at all
    });
    assert.equal(out.status, 'FAILED');
    assert.equal(out.safeToRetry, true);
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '0');
  });

  it('inside the settlement window a missing movement pends rather than fails', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill); // created just now, well inside the window

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId, bankClient: bank([])
    });
    assert.equal(out.status, 'IN_DOUBT');
    assert.equal(out.resolutionPending, true);
    assert.ok(out.retryAfterMinutes > 0);

    const { rows } = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(rows[0].status, 'IN_DOUBT', 'still resolvable, nothing decided');
  });

  it('a confirmed charge settles the bill', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const result = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '126000',
      payer: payer(), idempotencyKey: `ok-${seq}`, bankClient: confirmingBank('900000000556')
    });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.bankReference, '900000000556');
    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '126000');
    assert.equal(stored.status, 'CLOSED');
  });

  it('a confirmed debit against a bill that closed mid-flight is parked, not lost', async () => {
    // The bank pulled the money; between our commit of the PENDING row and the
    // settlement, the bill was voided at the till. The debit is real and cannot
    // be applied, so the charge goes to AMBIGUOUS for a person to refund --
    // never FAILED (the diner was debited), never silently dropped.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });

    // The race, made deterministic: the bill is OPEN when the charge starts
    // (so the pre-charge check passes and the PENDING row commits), and the
    // bank confirms only after voiding it -- which is the window between our
    // two transactions collapsed into one call.
    const racingBank = {
      async charge() {
        await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [bill.id]);
        return { status: 'SUCCEEDED', providerPaymentId: null, bankReference: '900000000557' };
      },
      async search() { return []; }
    };

    const result = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '126000',
      payer: payer(), idempotencyKey: `park-${seq}`, bankClient: racingBank
    });

    assert.equal(result.status, 'AMBIGUOUS');
    assert.equal(result.requiresStaffReview, true);
    assert.equal(result.bankReference, '900000000557');

    const { rows } = await db.query(
      'SELECT status, provider_payment_id FROM payments WHERE id = $1', [result.paymentId]);
    assert.equal(rows[0].status, 'AMBIGUOUS', 'parked, not settled and not failed');
    assert.equal(rows[0].provider_payment_id, '900000000557', 'the spent reference is recorded');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.status, 'VOID', 'the voided bill is untouched');
    assert.equal(stored.amount_paid_ves, '0');
  });
});
