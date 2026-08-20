const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const {
  createC2PPayment, resolveC2PPayment, listUnresolved, buildInvoiceNumber
} = require('../../src/services/mercantilC2P');
const splits = require('../../src/services/splits');
const billItems = require('../../src/services/billItems');
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

  it('the stored invoice number follows the server-owned policy', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);

    const { rows } = await db.query(
      'SELECT invoice_number FROM c2p_charges WHERE payment_id = $1', [paymentId]);
    const invoice = rows[0].invoice_number;

    assert.match(invoice, /^SPL-[0-9A-F]{8}-[0-9A-F]{32}$/, 'canonical shape');
    // Embeds this restaurant and the full payment id, so the row is auditable
    // back to both from the invoice alone.
    assert.ok(invoice.includes(restaurant.id.replace(/-/g, '').slice(0, 8).toUpperCase()));
    assert.ok(invoice.endsWith(paymentId.replace(/-/g, '').toUpperCase()));
  });

  it('the database refuses a malformed invoice number', async () => {
    // The CHECK from migration 021: a non-conforming invoice cannot be stored,
    // even by a write that goes around the service.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await assert.rejects(
      () => db.query(
        `UPDATE c2p_charges SET invoice_number = 'not-a-valid-invoice' WHERE payment_id = $1`,
        [paymentId]),
      err => err.code === '23514' && /invoice_format/.test(String(err.constraint || ''))
    );
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
  it('a matched charge the bill can no longer take is parked, not left in doubt', async () => {
    // The mirror of the charge-path case above, on the resolution path. The
    // bank has *shown us the movement* -- so IN_DOUBT, which asserts we do not
    // know whether the money moved, has stopped being true -- and the bill
    // closed while the charge sat in the queue. Rethrowing left the row
    // IN_DOUBT, and every later resolve repeated the same query, matched the
    // same movement and failed identically, so the charge never reached a
    // person while the diner stayed debited.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);

    // Somebody else settles the bill while the charge is in doubt.
    await db.query(
      "UPDATE bills SET amount_paid_ves = 126000, status = 'CLOSED' WHERE id = $1", [bill.id]);

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId,
      bankClient: bank([movement({ reference: '900000000801' })])
    });

    assert.equal(out.status, 'AMBIGUOUS');
    assert.equal(out.requiresStaffReview, true);
    assert.match(out.reason, /fully paid/);

    const { rows } = await db.query(
      'SELECT status, provider_payment_id FROM payments WHERE id = $1', [paymentId]);
    assert.equal(rows[0].status, 'AMBIGUOUS');
    // Recorded so the movement is spent and cannot settle somebody else, and so
    // whoever refunds it has the reference in hand.
    assert.equal(rows[0].provider_payment_id, '900000000801');

    // The bill is untouched: it was already paid, and this money is not its.
    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '126000');
    assert.equal(stored.status, 'CLOSED');
  });

  it('a parked resolution leaves staff a reason rather than a silent queue entry', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);
    await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [bill.id]);

    await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId,
      bankClient: bank([movement({ reference: '900000000802' })])
    });

    // The attempt row and last_resolution_at both used to roll back with the
    // failed settlement, so the queue showed a charge that looked untried.
    const attempts = await db.query(
      'SELECT outcome, reason FROM c2p_resolution_attempts WHERE payment_id = $1', [paymentId]);
    assert.equal(attempts.rows.length, 1);
    assert.equal(attempts.rows[0].outcome, 'UNAPPLIABLE');
    assert.match(attempts.rows[0].reason, /not open|fully paid/);

    const queued = (await listUnresolved({ restaurantId: restaurant.id }))
      .find(row => row.id === paymentId);
    assert.ok(queued, 'a parked charge is in the queue a person works');
    assert.equal(queued.status, 'AMBIGUOUS');
    assert.ok(queued.last_resolution_at, 'and reads as tried');
    assert.match(queued.last_reason, /not open|fully paid/);
  });

  it('asking again about a parked charge reports it resolved instead of looping', async () => {
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);
    await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [bill.id]);
    const shared = bank([movement({ reference: '900000000803' })]);

    assert.equal((await resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: shared })).status, 'AMBIGUOUS');

    const again = await resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: shared });
    assert.equal(again.alreadyResolved, true);
    assert.equal(again.status, 'AMBIGUOUS');
  });

  it('a transient failure keeps the charge in doubt so the retry can still settle', async () => {
    // Parking is a one-way door: only a person leaves AMBIGUOUS. A statement
    // timeout says nothing about the bill, so it must not send a charge that
    // would have settled cleanly into a refund queue.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [paymentId]);
    const shared = bank([movement({ reference: '900000000804' })]);

    const realTransaction = db.withTransaction;
    let firstCall = true;
    db.withTransaction = async (...args) => {
      if (firstCall) {
        firstCall = false;
        const timeout = new Error('canceling statement due to statement timeout');
        timeout.code = '57014';
        throw timeout;
      }
      return realTransaction.apply(db, args);
    };

    try {
      await assert.rejects(
        () => resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: shared }),
        err => err.code === '57014'
      );
      const { rows } = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
      assert.equal(rows[0].status, 'IN_DOUBT', 'still unresolved, still retryable');
    } finally {
      db.withTransaction = realTransaction;
    }

    // And the retry settles, which is the whole point of not parking above.
    const out = await resolveC2PPayment({ restaurantId: restaurant.id, paymentId, bankClient: shared });
    assert.equal(out.status, 'SUCCEEDED');
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '126000');
  });
  it('one debit cannot settle two bills because two endpoints spelled it differently', async () => {
    // The charge endpoint quotes the reference grouped; the search endpoint
    // returns it plain. Stored as they arrived, those are two strings: the
    // unique index does not collide, the spent-movement probe does not match,
    // and the same money closes two tables.
    const billA = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const settled = await createC2PPayment({
      restaurantId: restaurant.id, billId: billA.id, amountVes: '126000',
      payer: payer(), idempotencyKey: `spellA-${seq}-${Math.random().toString(36).slice(2)}`,
      bankClient: {
        async charge() {
          return { status: 'SUCCEEDED', providerPaymentId: null, bankReference: '9000 0000 0999' };
        },
        async search() { return []; }
      }
    });
    assert.equal(settled.status, 'SUCCEEDED');

    const { rows } = await db.query(
      'SELECT provider_payment_id FROM payments WHERE id = $1', [settled.paymentId]);
    assert.equal(rows[0].provider_payment_id, '900000000999', 'stored under the one spelling');

    // A second charge, in doubt, whose search returns that same movement plain.
    const billB = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const doubtful = await inDoubtCharge(billB);
    await db.query(
      "UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [doubtful.paymentId]);

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId: doubtful.paymentId,
      bankClient: bank([movement({ reference: '900000000999' })])
    });

    assert.notEqual(out.status, 'SUCCEEDED', 'a spent movement cannot settle a second charge');
    assert.equal((await fixtures.readBill(billA.id)).amount_paid_ves, '126000');
    assert.equal((await fixtures.readBill(billB.id)).amount_paid_ves, '0');
  });

  it('a non-numeric provider id survives storage intact', async () => {
    // referenceFor falls back to providerPaymentId when the bank sends no
    // reference. Canonicalising by stripping digits would store `019` here.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const result = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '126000',
      payer: payer(), idempotencyKey: `provid-${seq}-${Math.random().toString(36).slice(2)}`,
      bankClient: {
        async charge() {
          return { status: 'SUCCEEDED', providerPaymentId: 'TX-0F2A-19', bankReference: null };
        },
        async search() { return []; }
      }
    });

    const { rows } = await db.query(
      'SELECT provider_payment_id FROM payments WHERE id = $1', [result.paymentId]);
    assert.equal(rows[0].provider_payment_id, 'TX-0F2A-19');
  });

  it('refuses to conclude anything about a charge older than the search window', async () => {
    // `from` is floored at now-6h, so past that age the window no longer
    // contains the moment the charge happened. Both conclusions become unsafe
    // at once: an empty answer is about the wrong hours, and a matching
    // movement at this remove is more likely the same payer paying again than
    // this charge finally showing up.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '9 hours' WHERE id = $1", [paymentId]);

    let asked = false;
    const watchfulBank = {
      async charge() { throw new MercantilC2PError('BANK_INDETERMINATE', 'no response'); },
      async search() { asked = true; return []; }
    };

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId, bankClient: watchfulBank
    });

    assert.equal(asked, false, 'no point spending a bank call on an unanswerable question');
    assert.equal(out.status, 'AMBIGUOUS');
    assert.equal(out.requiresStaffReview, true);
    // The old behaviour: FAILED with safeToRetry true, on a debit that may well
    // have landed. That is the sentence this test exists to prevent.
    assert.equal(out.safeToRetry, false);

    const { rows } = await db.query('SELECT status FROM payments WHERE id = $1', [paymentId]);
    assert.equal(rows[0].status, 'AMBIGUOUS');
    assert.notEqual(rows[0].status, 'FAILED');

    const attempts = await db.query(
      'SELECT outcome FROM c2p_resolution_attempts WHERE payment_id = $1', [paymentId]);
    assert.equal(attempts.rows[0].outcome, 'WINDOW_EXPIRED');

    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '0');
  });

  it('a charge inside the window is still resolved normally', async () => {
    // The guard above must be an edge, not a ceiling: five hours is inside six.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { paymentId } = await inDoubtCharge(bill);
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '5 hours' WHERE id = $1", [paymentId]);

    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId,
      bankClient: bank([movement({ reference: '900000000901' })])
    });

    assert.equal(out.status, 'SUCCEEDED');
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '126000');
  });

  it('a matched charge whose split went stale is parked, not retried forever', async () => {
    // A settlement credits the bill *and* the share, so it can be refused from
    // either side. The bill-side refusals were handled; these were not, and a
    // debited charge on a staled split re-queried the bank on every resolve
    // while the diner stayed debited.
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id,
      tableId: (await fixtures.createTable(restaurant.id, { name: `SP${++seq}` })).id,
      totalDue: 0, totalDueVes: 0
    });
    const product = (await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, 'Ron', 63000, 'VES') RETURNING id`, [restaurant.id])).rows[0];
    await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product.id, quantity: 2
    });

    const billRow = (await db.query(
      `SELECT id, status, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit
         FROM bills WHERE id = $1`, [bill.id])).rows[0];
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill: billRow,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] },
      createdBy: { type: 'STAFF', id: null }
    });
    const share = split.participants[0];

    const charge = await createC2PPayment({
      restaurantId: restaurant.id, billId: bill.id, amountVes: share.amount_ves,
      payer: payer(), idempotencyKey: `stale-${seq}-${Math.random().toString(36).slice(2)}`,
      splitParticipantId: share.id, bankClient: bank()
    });
    assert.equal(charge.status, 'IN_DOUBT');
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '30 minutes' WHERE id = $1", [charge.paymentId]);

    // The table orders another round while the charge is in doubt.
    await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product.id, quantity: 1
    });
    assert.equal(
      (await db.query('SELECT status FROM bill_splits WHERE id = $1', [split.split.id])).rows[0].status,
      'STALE'
    );

    const shared = bank([movement({ reference: '900000000902', amountMinor: share.amount_ves })]);
    const out = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId: charge.paymentId, bankClient: shared
    });

    assert.equal(out.status, 'AMBIGUOUS', 'parked for a person, not thrown back at one');
    assert.equal(
      (await db.query('SELECT status FROM payments WHERE id = $1', [charge.paymentId])).rows[0].status,
      'AMBIGUOUS'
    );

    // And asking again does not restart the loop.
    const again = await resolveC2PPayment({
      restaurantId: restaurant.id, paymentId: charge.paymentId, bankClient: shared
    });
    assert.equal(again.alreadyResolved, true);
  });

  it('a failed in-doubt transition never releases the charge back to the caller', async () => {
    // The route aborts the idempotency key on a throw, which would let the
    // client raise a second charge for a debit that may already have landed.
    // Our own bookkeeping failing must not cause the one thing this rail exists
    // to prevent.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });

    const realTransaction = db.withTransaction;
    let calls = 0;
    db.withTransaction = async (...args) => {
      calls += 1;
      if (calls === 2) {                       // 1 = the PENDING insert, 2 = the IN_DOUBT move
        const timeout = new Error('canceling statement due to statement timeout');
        timeout.code = '57014';
        throw timeout;
      }
      return realTransaction.apply(db, args);
    };

    let result;
    try {
      result = await createC2PPayment({
        restaurantId: restaurant.id, billId: bill.id, amountVes: '126000',
        payer: payer(), idempotencyKey: `guard-${seq}-${Math.random().toString(36).slice(2)}`,
        bankClient: bank()
      });
    } finally {
      db.withTransaction = realTransaction;
    }

    // IN_DOUBT is true of the charge whatever happened to the row.
    assert.equal(result.status, 'IN_DOUBT');
    assert.equal(result.requiresResolution, true);

    const { rows } = await db.query('SELECT status FROM payments WHERE id = $1', [result.paymentId]);
    assert.equal(rows[0].status, 'PENDING', 'the transition genuinely did not land');

    // ...which is exactly why the queue has to read PENDING too, or this charge
    // would be the one kind nothing ever shows.
    await db.query("UPDATE payments SET created_at = NOW() - INTERVAL '2 hours' WHERE id = $1", [result.paymentId]);
    const queued = (await listUnresolved({ restaurantId: restaurant.id }))
      .find(row => row.id === result.paymentId);
    assert.ok(queued, 'a stuck PENDING charge is visible to staff');
    assert.equal(queued.status, 'PENDING');
  });

  it('a charge still in flight is not paraded as stuck', async () => {
    // PENDING is normal for the seconds the bank call takes. The queue reads it
    // only past the settlement window, or every live charge would look broken.
    const bill = await freshBill({ totalDue: 126000, totalDueVes: 126000 });
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, provider, payer_type)
       VALUES ($1, $2, 126000, 'PENDING', 'C2P', 'MERCANTIL', 'GUEST') RETURNING id`,
      [restaurant.id, bill.id]
    );
    await db.query(
      `INSERT INTO c2p_charges (payment_id, restaurant_id, invoice_number, payer_bank_code, payer_phone_last4)
       VALUES ($1, $2, $3, '0105', '1234')`,
      // Built by the same helper the charge path uses: the invoice format is a
      // database CHECK, not a convention.
      [rows[0].id, restaurant.id, buildInvoiceNumber({ restaurantId: restaurant.id, paymentId: rows[0].id })]
    );

    const queued = (await listUnresolved({ restaurantId: restaurant.id }))
      .find(row => row.id === rows[0].id);
    assert.equal(queued, undefined);
  });
});
