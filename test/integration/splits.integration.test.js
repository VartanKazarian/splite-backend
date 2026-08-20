const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const splits = require('../../src/services/splits');
const { processSplitPayment } = require('../../src/services/locks');
const billItems = require('../../src/services/billItems');
const claims = require('../../src/services/paymentClaims');

/**
 * Persistent splits against a real Postgres. The point of the feature is that
 * the invariants are the database's, not the service's, so most of these prove
 * a raw write cannot get past them -- an API that forgot the rule still cannot
 * break it.
 */
describe('persistent bill splits against a real Postgres', { skip }, () => {
  let restaurant;
  let seq = 0;

  let staffUserId;
  before(async () => {
    restaurant = await fixtures.createRestaurant();
    staffUserId = (await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, 'split-test@example.com', 'x', 'MANAGER') RETURNING id`,
      [restaurant.id]
    )).rows[0].id;
  });
  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const freshBill = async (total = 20000) => {
    const table = await fixtures.createTable(restaurant.id, { name: `S${++seq}` });
    return fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: total, totalDueVes: total });
  };

  const addItem = async (billId, { price, qty = 1, name = 'Item' }) => {
    const { rows } = await db.query(
      `INSERT INTO bill_items (restaurant_id, bill_id, name_snapshot, unit_price_minor, currency, quantity)
       VALUES ($1,$2,$3,$4,'VES',$5) RETURNING id, subtotal_minor`,
      [restaurant.id, billId, name, String(price), qty]
    );
    return rows[0];
  };

  const staff = { type: 'STAFF', get id() { return staffUserId; } };

  it('a verified transfer still reaches the bill when its share went stale', async () => {
    // Staff have found this money in the bank account, so its arrival is not in
    // question -- only where to file it. Rolling the confirmation back left a
    // verified transfer stuck PENDING with no path to the bill at all, forever,
    // because a refusal about the *plan* cannot be argued with by retrying.
    const { bill, product } = await itemisedBill(10000, 2);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const share = split.participants[0];
    const claim = await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: share.amount_ves,
      reference: `${Date.now()}`.slice(-12), splitParticipantId: share.id,
      payer: { type: 'GUEST', id: null }
    });

    // The round that arrives while the claim sits in the queue.
    await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product, quantity: 1
    });
    assert.equal(
      (await db.query('SELECT status FROM bill_splits WHERE id = $1', [split.split.id])).rows[0].status,
      'STALE'
    );

    const out = await claims.confirmClaim({
      restaurantId: restaurant.id, claimId: claim.id, actor: { id: staffUserId }
    });

    assert.equal(out.amountPaid, '10000', 'the money is on the bill');
    assert.equal(out.shareDetached, 'SPLIT_STALE', 'and the client is told why the split still shows them owing');

    const payment = (await db.query(
      'SELECT status, split_participant_id FROM payments WHERE id = $1', [claim.id])).rows[0];
    assert.equal(payment.status, 'SUCCEEDED');
    // Cleared rather than left dangling: a settled payment still naming a share
    // it never credited is permanent drift.
    assert.equal(payment.split_participant_id, null);

    const drift = await db.query(
      'SELECT * FROM bill_split_share_drift WHERE split_id = $1', [split.split.id]);
    assert.equal(drift.rows.length, 0, 'the share counter and the ledger still agree');
  });

  it('a share that can still take the money is credited as before', async () => {
    // The detach is an exception, not the new normal: nothing changes on the
    // ordinary path.
    const { bill } = await itemisedBill(10000, 2);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const share = split.participants[0];
    const claim = await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: share.amount_ves,
      reference: `${Date.now() + 1}`.slice(-12), splitParticipantId: share.id,
      payer: { type: 'GUEST', id: null }
    });

    const out = await claims.confirmClaim({
      restaurantId: restaurant.id, claimId: claim.id, actor: { id: staffUserId }
    });
    assert.equal(out.shareDetached, undefined);

    const payment = (await db.query(
      'SELECT split_participant_id FROM payments WHERE id = $1', [claim.id])).rows[0];
    assert.equal(payment.split_participant_id, share.id);
    assert.equal(
      (await db.query('SELECT amount_paid_ves FROM bill_split_participants WHERE id = $1', [share.id]))
        .rows[0].amount_paid_ves,
      share.amount_ves
    );
  });

  it('a split cannot be voided while a payment against a share is in flight', async () => {
    // Settled money is not the only money. Voiding out from under a declared
    // transfer strands it: the share no longer accepts anything, so confirming
    // it later has nowhere to put money that has genuinely arrived.
    const { bill } = await itemisedBill(10000, 2);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const share = split.participants[0];
    const claim = await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: share.amount_ves,
      reference: `${Date.now() + 2}`.slice(-12), splitParticipantId: share.id,
      payer: { type: 'GUEST', id: null }
    });

    await assert.rejects(
      () => splits.voidSplit({
        restaurantId: restaurant.id, billId: bill.id, splitId: split.split.id, actor: staff
      }),
      err => err.code === 'SPLIT_HAS_PAYMENTS' && err.details?.inFlightPayments === 1
    );

    // Rejecting the claim is the step that unblocks it, and the error says so.
    await claims.rejectClaim({
      restaurantId: restaurant.id, claimId: claim.id, reason: 'Not in the account', actor: { id: staffUserId }
    });
    const voided = await splits.voidSplit({
      restaurantId: restaurant.id, billId: bill.id, splitId: split.split.id, actor: staff
    });
    assert.equal(voided.split.status, 'VOID');
  });

  it('a voided bill cannot be given a split', async () => {
    // The failure this prevents is not an error message -- it is a plan the
    // table agrees to and then cannot settle. The shares compute perfectly
    // against a VOID bill's outstanding balance, so staff could read them out,
    // and every payment against them is refused by applyToBill one diner at a
    // time, at the till, after the group thought the question was closed.
    const bill = await freshBill(20000);
    await db.query("UPDATE bills SET status = 'VOID' WHERE id = $1", [bill.id]);
    const voided = await fixtures.readBill(bill.id);

    await assert.rejects(
      () => splits.createSplit({
        restaurantId: restaurant.id, bill: voided,
        request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
      }),
      err => err.code === 'BILL_NOT_OPEN' && err.statusCode === 409
    );

    const { rows } = await db.query('SELECT id FROM bill_splits WHERE bill_id = $1', [bill.id]);
    assert.equal(rows.length, 0, 'nothing is written for a bill nobody can pay');
  });

  it('a settled bill is refused for its status, not its arithmetic', async () => {
    // CLOSED was already refused, but by the engine: a fully paid bill has
    // nothing outstanding, so the basis was rejected without the bill's state
    // ever being consulted. Right answer, wrong reason -- and one that stops
    // holding the moment any status other than OPEN can carry a balance.
    const bill = await freshBill(20000);
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 20000
    });
    const closed = await fixtures.readBill(bill.id);
    assert.equal(closed.status, 'CLOSED');

    await assert.rejects(
      () => splits.createSplit({
        restaurantId: restaurant.id, bill: closed,
        request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
      }),
      err => err.code === 'BILL_NOT_OPEN'
    );
  });

  it('a bill object with no status is refused rather than assumed open', async () => {
    // The check is only as good as the column reaching it, and the staff route
    // did not select `status` at all until this change. Failing closed means a
    // caller that forgets it gets an error instead of the old behaviour back.
    const bill = await freshBill(20000);
    const { id, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit } = bill;

    await assert.rejects(
      () => splits.createSplit({
        restaurantId: restaurant.id,
        bill: { id, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit },
        request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
      }),
      err => err.code === 'BILL_NOT_OPEN'
    );
  });

  it('an EQUAL split persists shares that sum to the outstanding balance', async () => {
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Luis' }] },
      createdBy: staff
    });

    assert.equal(split.split.basis_ves, '20000');
    assert.equal(split.participants.length, 2);
    const sum = split.participants.reduce((t, p) => t + BigInt(p.amount_ves), 0n);
    assert.equal(sum, 20000n);
    for (const p of split.participants) assert.equal(p.amount_ves, '10000');
  });

  it('the database refuses a split whose shares do not sum to its basis', async () => {
    // A raw write that bypasses the engine still cannot commit: the deferred
    // constraint checks the shares against the basis at commit, whole.
    const bill = await freshBill(20000);
    await assert.rejects(
      () => db.withTransaction(async client => {
        const s = (await client.query(
          `INSERT INTO bill_splits (restaurant_id, bill_id, mode, basis_ves, created_by_type)
           VALUES ($1,$2,'EQUAL',20000,'STAFF') RETURNING id`, [restaurant.id, bill.id])).rows[0];
        // 9000 + 9000 = 18000, not 20000.
        await client.query(
          `INSERT INTO bill_split_participants (restaurant_id, split_id, ext_ref, amount_ves)
           VALUES ($1,$2,'a',9000),($1,$2,'b',9000)`, [restaurant.id, s.id]);
      }),
      err => /shares sum to .* but its basis is/.test(err.message)
    );
  });

  it('a bill has at most one active split', async () => {
    const bill = await freshBill(10000);
    await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'FULL', participants: [{ id: 'a' }] }, createdBy: staff
    });
    await assert.rejects(
      () => splits.createSplit({
        restaurantId: restaurant.id, bill,
        request: { mode: 'FULL', participants: [{ id: 'b' }] }, createdBy: staff
      }),
      err => err.code === 'SPLIT_ALREADY_EXISTS' && err.statusCode === 409
    );
  });

  it('paying a share advances the share and the bill together', async () => {
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const shareA = split.participants[0].id;

    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id,
      amountPaidMinorUnits: 10000, splitParticipantId: shareA
    });

    const after = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    const a = after.participants.find(p => p.id === shareA);
    assert.equal(a.amount_paid_ves, '10000', 'the share is credited');
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '10000', 'the bill advances too');
  });

  it('a payment cannot exceed what is left on its share', async () => {
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const shareA = split.participants[0].id;

    // The share is 10000; try to pay 12000 against it.
    await assert.rejects(
      () => processSplitPayment({
        restaurantId: restaurant.id, billId: bill.id,
        amountPaidMinorUnits: 12000, splitParticipantId: shareA
      }),
      err => err.code === 'SPLIT_SHARE_OVERPAID' && err.statusCode === 409
    );

    // The whole transaction rolled back: the bill did not advance either.
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '0', 'a rejected share payment moves nothing');
  });

  it('the share amount is immutable once agreed', async () => {
    const bill = await freshBill(10000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'FULL', participants: [{ id: 'a' }] }, createdBy: staff
    });
    await assert.rejects(
      () => db.query('UPDATE bill_split_participants SET amount_ves = 5000 WHERE id = $1', [split.participants[0].id]),
      err => /amount_ves is immutable/.test(err.message)
    );
  });

  it('a split can only be voided through the bill it belongs to', async () => {
    // `/bills/:id/splits/:splitId/void` states a containment relationship, and
    // nothing enforced it: the bill in the path was never passed on, so any of
    // the restaurant's own bill ids voided any of its splits. Crossed ids in a
    // client voided the wrong table's plan and returned a split naming a bill
    // the caller had not asked about.
    const mine = await freshBill(10000);
    const other = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill: other,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });

    await assert.rejects(
      () => splits.voidSplit({
        restaurantId: restaurant.id, billId: mine.id, splitId: split.split.id, actor: staff
      }),
      // Not "wrong bill": at that address the split does not exist, which is
      // the same answer a split from another tenant gets.
      err => err.code === 'SPLIT_NOT_FOUND' && err.statusCode === 404
    );

    const untouched = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    assert.equal(untouched.split.status, 'ACTIVE', "the other bill's plan is still live");

    // And voiding it from its own bill still works, so the check is a scope and
    // not a wall.
    const voided = await splits.voidSplit({
      restaurantId: restaurant.id, billId: other.id, splitId: split.split.id, actor: staff
    });
    assert.equal(voided.split.status, 'VOID');
  });

  it('voiding through the wrong bill leaves the one-active-split rule intact', async () => {
    // The consequence that outlives the bad void: voiding releases the partial
    // unique index, so a plan voided from somewhere else lets a second split be
    // created under a group still settling against the first.
    const decoy = await freshBill(10000);
    const live = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill: live,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });

    await assert.rejects(() => splits.voidSplit({
      restaurantId: restaurant.id, billId: decoy.id, splitId: split.split.id, actor: staff
    }));

    await assert.rejects(
      () => splits.createSplit({
        restaurantId: restaurant.id, bill: live,
        request: { mode: 'FULL', participants: [{ id: 'c' }] }, createdBy: staff
      }),
      err => err.code === 'SPLIT_ALREADY_EXISTS' && err.statusCode === 409
    );
  });

  it('a split with payments against it cannot be voided; an untouched one can', async () => {
    const paid = await freshBill(10000);
    const paidSplit = await splits.createSplit({
      restaurantId: restaurant.id, bill: paid,
      request: { mode: 'FULL', participants: [{ id: 'a' }] }, createdBy: staff
    });
    await processSplitPayment({
      restaurantId: restaurant.id, billId: paid.id,
      amountPaidMinorUnits: 10000, splitParticipantId: paidSplit.participants[0].id
    });
    await assert.rejects(
      () => splits.voidSplit({
        restaurantId: restaurant.id, billId: paid.id, splitId: paidSplit.split.id, actor: staff
      }),
      err => err.code === 'SPLIT_HAS_PAYMENTS' && err.statusCode === 409
    );

    const clean = await freshBill(10000);
    const cleanSplit = await splits.createSplit({
      restaurantId: restaurant.id, bill: clean,
      request: { mode: 'FULL', participants: [{ id: 'a' }] }, createdBy: staff
    });
    const voided = await splits.voidSplit({
      restaurantId: restaurant.id, billId: clean.id, splitId: cleanSplit.split.id, actor: staff
    });
    assert.equal(voided.split.status, 'VOID');

    // Voiding frees the bill for a new split.
    await splits.createSplit({
      restaurantId: restaurant.id, bill: clean,
      request: { mode: 'FULL', participants: [{ id: 'b' }] }, createdBy: staff
    });
  });

  it('a payment cannot credit a share that belongs to a different bill', async () => {
    // Paying bill B while citing a share of bill A's split must not mark A's
    // share paid. The advance is scoped to the bill actually being settled.
    const billA = await freshBill(10000);
    const splitA = await splits.createSplit({
      restaurantId: restaurant.id, bill: billA,
      request: { mode: 'FULL', participants: [{ id: 'a' }] }, createdBy: staff
    });
    const billB = await freshBill(10000);

    await assert.rejects(
      () => processSplitPayment({
        restaurantId: restaurant.id, billId: billB.id,
        amountPaidMinorUnits: 10000, splitParticipantId: splitA.participants[0].id
      }),
      err => err.code === 'SPLIT_SHARE_NOT_FOUND'
    );

    // Neither bill nor share moved.
    assert.equal((await fixtures.readBill(billB.id)).amount_paid_ves, '0');
    const a = await splits.getSplit({ restaurantId: restaurant.id, splitId: splitA.split.id });
    assert.equal(a.participants[0].amount_paid_ves, '0');
  });

  it('simultaneous diners paying their own distinct shares all settle', async () => {
    // The table pays at once: Ana taps her share the same instant Luis taps his.
    // Both credit their own share and the bill closes exactly once.
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const [pa, pb] = split.participants.map(p => p.id);

    const res = await Promise.allSettled([
      processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 10000, splitParticipantId: pa }),
      processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 10000, splitParticipantId: pb })
    ]);
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 2, 'both distinct-share payments settle');

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid_ves, '20000');
    assert.equal(stored.status, 'CLOSED');
  });

  it('two payments racing for one share settle it exactly once', async () => {
    // A double-tap, or two devices on the same share. The participant row is
    // locked FOR UPDATE, so the second wakes to a share already full and is
    // rejected on its ceiling rather than both crediting.
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const pa = split.participants[0].id;

    const res = await Promise.allSettled([
      processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 10000, splitParticipantId: pa }),
      processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 10000, splitParticipantId: pa })
    ]);
    assert.equal(res.filter(r => r.status === 'fulfilled').length, 1, 'exactly one credits the share');
    for (const r of res) {
      if (r.status === 'rejected') assert.equal(r.reason.code, 'SPLIT_SHARE_OVERPAID');
    }
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '10000', 'the share is credited once');
  });

  it('a diner cannot overpay their allocation even while the bill has room', async () => {
    // Ana owes 8000 of a 20000 bill. She tries to pay 12000 -- the bill is
    // nowhere near full, but her share is, so the participant ceiling rejects it
    // where the bill ceiling would not. This is the whole point of persisting
    // the split: a plan people agreed to, not just a total not to exceed.
    const bill = await freshBill(20000);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'CUSTOM', participants: [{ id: 'a', amountVes: '8000' }, { id: 'b', amountVes: '12000' }] },
      createdBy: staff
    });
    const ana = split.participants.find(p => p.ext_ref === 'a').id;

    await assert.rejects(
      () => processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 12000, splitParticipantId: ana }),
      err => err.code === 'SPLIT_SHARE_OVERPAID' && err.statusCode === 409
    );
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '0', 'nothing moved');
  });

  /** An itemised bill: opened at zero, then priced by its lines. */
  const itemisedBill = async (unitPrice, quantity) => {
    const table = await fixtures.createTable(restaurant.id, { name: `I${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    const product = (await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
       VALUES ($1, $2, $3, 'VES', true) RETURNING id`,
      [restaurant.id, `P${seq}-${Math.random().toString(36).slice(2, 8)}`, String(unitPrice)]
    )).rows[0].id;
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: product, quantity });
    return { bill: await fixtures.readBill(bill.id), product };
  };

  it('a split goes STALE when the bill changes under it, and the table is told', async () => {
    // The scenario this whole status exists for: the table agrees a split, then
    // orders another round. Before STALE, the split went on claiming the old
    // total, both diners paid in full, and the bill sat OPEN with the difference
    // owed by nobody -- the diners believing they were square.
    const { bill, product } = await itemisedBill(10000, 2);
    assert.equal(bill.total_due_ves, '20000');

    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    assert.equal(split.split.status, 'ACTIVE');

    // Another round.
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: product, quantity: 1 });

    const after = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    assert.equal(after.split.status, 'STALE', 'the split no longer governs the bill');
    assert.equal((await fixtures.readBill(bill.id)).total_due_ves, '30000');

    // And the read surface says so, rather than showing nothing.
    const current = await splits.getActiveSplit({ restaurantId: restaurant.id, billId: bill.id });
    assert.equal(current.split.id, split.split.id);
    assert.equal(current.split.status, 'STALE');
  });

  it('a stale share takes no further payment', async () => {
    const { bill, product } = await itemisedBill(10000, 2);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: product, quantity: 1 });

    await assert.rejects(
      () => processSplitPayment({
        restaurantId: restaurant.id, billId: bill.id,
        amountPaidMinorUnits: 10000, splitParticipantId: split.participants[0].id
      }),
      err => err.code === 'SPLIT_STALE' && err.statusCode === 409
    );
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '0', 'nothing moved');
  });

  it('money already paid into a split survives it going stale, and a fresh split covers the rest', async () => {
    const { bill, product } = await itemisedBill(10000, 2);   // 20000
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    // Ana pays her half while the split is still good.
    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id,
      amountPaidMinorUnits: 10000, splitParticipantId: split.participants[0].id
    });

    // Then the round arrives: bill 20000 -> 30000, split goes stale.
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: product, quantity: 1 });
    const stale = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    assert.equal(stale.split.status, 'STALE');
    assert.equal(stale.participants[0].amount_paid_ves, '10000', 'her payment is still hers');
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '10000', 'and still on the bill');

    // The group agrees a new split on what is actually left -- the stale one no
    // longer holds the one-active-per-bill index.
    const rest = await fixtures.readBill(bill.id);
    const second = await splits.createSplit({
      restaurantId: restaurant.id, bill: rest,
      request: { mode: 'EQUAL', participants: [{ id: 'b' }, { id: 'c' }] }, createdBy: staff
    });
    assert.equal(second.split.basis_ves, '20000', 'the new plan divides only the outstanding balance');

    // Paying it out closes the bill -- the failure this whole feature fixes.
    for (const p of second.participants) {
      await processSplitPayment({
        restaurantId: restaurant.id, billId: bill.id,
        amountPaidMinorUnits: p.amount_ves, splitParticipantId: p.id
      });
    }
    const closed = await fixtures.readBill(bill.id);
    assert.equal(closed.amount_paid_ves, '30000');
    assert.equal(closed.status, 'CLOSED', 'the table can be cleared');
  });

  it('an edit that does not move the total leaves the split standing', async () => {
    // Staleness is about the figure, not about the fact of an edit: setting a
    // quantity to what it already was must not tear up an agreement.
    const { bill } = await itemisedBill(10000, 2);
    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      request: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, createdBy: staff
    });
    const item = (await billItems.listForBill({ restaurantId: restaurant.id, billId: bill.id }))[0];
    await billItems.updateQuantity({
      restaurantId: restaurant.id, billId: bill.id, itemId: item.id, quantity: 2
    });
    const after = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    assert.equal(after.split.status, 'ACTIVE', 'unchanged total, unchanged agreement');
  });

  it('an ITEMS split persists whole-line claims and credits across rails on confirm', async () => {
    const bill = await freshBill(20000);
    const beer = await addItem(bill.id, { price: 12000, name: 'Beer' });
    const fries = await addItem(bill.id, { price: 8000, name: 'Fries' });

    const split = await splits.createSplit({
      restaurantId: restaurant.id, bill,
      items: await require('../../src/services/billItems').listForBill({ restaurantId: restaurant.id, billId: bill.id }),
      request: {
        mode: 'ITEMS',
        participants: [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Luis' }],
        claims: [
          { itemId: beer.id, participantIds: ['a'] },
          { itemId: fries.id, participantIds: ['b'] }
        ]
      },
      createdBy: staff
    });

    // Ana owes the beer (12000), Luis the fries (8000).
    const ana = split.participants.find(p => p.ext_ref === 'a');
    const luis = split.participants.find(p => p.ext_ref === 'b');
    assert.equal(ana.amount_ves, '12000');
    assert.equal(luis.amount_ves, '8000');
    assert.equal(split.claims.length, 2, 'claims are persisted');

    // Ana pays her share as a Pago Movil claim: PENDING settles nothing yet.
    const claim = await claims.declareClaim({
      restaurantId: restaurant.id, billId: bill.id, amountVes: '12000',
      reference: '778899', payer: { type: 'GUEST', id: null }, splitParticipantId: ana.id
    });
    let mid = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    assert.equal(mid.participants.find(p => p.ext_ref === 'a').amount_paid_ves, '0', 'a pending claim credits nothing');

    // Staff confirm it: the same transition that settles the bill credits the share.
    await claims.confirmClaim({ restaurantId: restaurant.id, claimId: claim.id, actor: staff });
    const done = await splits.getSplit({ restaurantId: restaurant.id, splitId: split.split.id });
    assert.equal(done.participants.find(p => p.ext_ref === 'a').amount_paid_ves, '12000', 'confirming credits the share');
    assert.equal((await fixtures.readBill(bill.id)).amount_paid_ves, '12000');
  });
});
