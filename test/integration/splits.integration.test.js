const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const splits = require('../../src/services/splits');
const { processSplitPayment } = require('../../src/services/locks');
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
      () => splits.voidSplit({ restaurantId: restaurant.id, splitId: paidSplit.split.id, actor: staff }),
      err => err.code === 'SPLIT_HAS_PAYMENTS' && err.statusCode === 409
    );

    const clean = await freshBill(10000);
    const cleanSplit = await splits.createSplit({
      restaurantId: restaurant.id, bill: clean,
      request: { mode: 'FULL', participants: [{ id: 'a' }] }, createdBy: staff
    });
    const voided = await splits.voidSplit({ restaurantId: restaurant.id, splitId: cleanSplit.split.id, actor: staff });
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
