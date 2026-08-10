const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { processSplitPayment } = require('../../src/services/locks');
const { transitionPayment, listForBill } = require('../../src/services/payments');

describe('payment ledger', { skip }, () => {
  let restaurant;
  let tableSeq = 0;

  before(async () => { restaurant = await fixtures.createRestaurant({ name: 'Ledger Tenant' }); });

  after(async () => {
    // destroyRestaurant clears the ledger before the bills it references.
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const freshBill = async (overrides = {}) => {
    const table = await fixtures.createTable(restaurant.id, { name: `L${++tableSeq}` });
    return fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, ...overrides });
  };

  it('records a payment and its opening transition', async () => {
    const bill = await freshBill({ totalDue: 10000 });

    const result = await processSplitPayment({
      restaurantId: restaurant.id,
      billId: bill.id,
      amountPaidMinorUnits: 2500,
      idempotencyKey: `ledger-${bill.id}`,
      payer: { type: 'STAFF', id: null }
    });

    const ledger = await listForBill(db, { restaurantId: restaurant.id, billId: bill.id });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount_ves, '2500');
    assert.equal(ledger[0].status, 'SUCCEEDED');
    assert.equal(ledger[0].id, result.paymentId);

    const { rows } = await db.query(
      'SELECT from_status, to_status FROM payment_transitions WHERE payment_id = $1',
      [result.paymentId]
    );
    assert.deepEqual(rows, [{ from_status: null, to_status: 'SUCCEEDED' }]);
  });

  it('keeps the cached balance and the ledger in agreement', async () => {
    const bill = await freshBill({ totalDue: 9000 });
    for (const amount of [3000, 3000, 3000]) {
      await processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: amount });
    }

    const stored = await fixtures.readBill(bill.id);
    assert.equal(stored.amount_paid, '9000');
    assert.equal(stored.status, 'CLOSED');

    // The view exists precisely so this is checkable rather than assumed.
    const drift = await db.query('SELECT * FROM payment_ledger_drift WHERE bill_id = $1', [bill.id]);
    assert.equal(drift.rows.length, 0, 'cache and ledger disagree');
  });

  it('leaves no ledger row when the payment is refused', async () => {
    const bill = await freshBill({ totalDue: 1000 });

    await assert.rejects(() => processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 5000
    }));

    // The insert and the balance update share a transaction, so a refused
    // payment must leave neither behind.
    const ledger = await listForBill(db, { restaurantId: restaurant.id, billId: bill.id });
    assert.equal(ledger.length, 0);
    assert.equal((await fixtures.readBill(bill.id)).amount_paid, '0');
  });

  it('refuses two payments under one idempotency key', async () => {
    const bill = await freshBill({ totalDue: 10000 });
    const key = `dup-${bill.id}`;

    await processSplitPayment({
      restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 1000, idempotencyKey: key
    });

    await assert.rejects(
      () => processSplitPayment({
        restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 1000, idempotencyKey: key
      }),
      err => {
        assert.equal(err.code, '23505', 'unique_violation');
        return true;
      }
    );
  });

  it('refuses a second payment for one provider reference', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    const insert = (ref) => db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, provider, provider_payment_id, payer_type)
       VALUES ($1,$2,'100','PENDING','CARD','acme',$3,'SYSTEM')`,
      [restaurant.id, bill.id, ref]
    );

    await insert('acme-ref-1');
    // A redelivered webhook must not be able to bank the same payment twice.
    await assert.rejects(() => insert('acme-ref-1'), err => {
      assert.equal(err.code, '23505');
      return true;
    });
  });

  it('enforces the state machine in the database', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
       VALUES ($1,$2,'500','PENDING','CASH','STAFF') RETURNING id`,
      [restaurant.id, bill.id]
    );
    const id = rows[0].id;

    await db.query("UPDATE payments SET status = 'SUCCEEDED' WHERE id = $1", [id]);

    // Money that has moved cannot be un-moved by a status change.
    await assert.rejects(
      () => db.query("UPDATE payments SET status = 'FAILED' WHERE id = $1", [id]),
      err => {
        assert.match(err.message, /illegal payment transition/);
        return true;
      }
    );

    // A refund is a legal onward move.
    await db.query("UPDATE payments SET status = 'REFUNDED' WHERE id = $1", [id]);
    // And REFUNDED is terminal.
    await assert.rejects(
      () => db.query("UPDATE payments SET status = 'SUCCEEDED' WHERE id = $1", [id]),
      err => /illegal payment transition/.test(err.message)
    );
  });

  it('refuses to change a settled amount', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
       VALUES ($1,$2,'500','SUCCEEDED','CASH','STAFF') RETURNING id`,
      [restaurant.id, bill.id]
    );

    await assert.rejects(
      () => db.query("UPDATE payments SET amount_ves = '999' WHERE id = $1", [rows[0].id]),
      err => {
        assert.match(err.message, /amount_ves is immutable/);
        return true;
      }
    );
  });

  it('records a transition through the service with its actor', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
       VALUES ($1,$2,'500','PENDING','CARD','SYSTEM') RETURNING id`,
      [restaurant.id, bill.id]
    );

    const updated = await db.withTransaction(client => transitionPayment(client, {
      paymentId: rows[0].id,
      restaurantId: restaurant.id,
      toStatus: 'SUCCEEDED',
      reason: 'provider confirmed',
      actorType: 'PROVIDER'
    }));
    assert.equal(updated.status, 'SUCCEEDED');

    const history = await db.query(
      'SELECT from_status, to_status, reason, actor_type FROM payment_transitions WHERE payment_id = $1 ORDER BY created_at',
      [rows[0].id]
    );
    assert.equal(history.rows.length, 1);
    assert.deepEqual(history.rows[0], {
      from_status: 'PENDING', to_status: 'SUCCEEDED', reason: 'provider confirmed', actor_type: 'PROVIDER'
    });
  });

  it('rejects an illegal transition with 409 before reaching the database', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
       VALUES ($1,$2,'500','CANCELLED','CASH','STAFF') RETURNING id`,
      [restaurant.id, bill.id]
    );

    await assert.rejects(
      () => db.withTransaction(client => transitionPayment(client, {
        paymentId: rows[0].id, restaurantId: restaurant.id, toStatus: 'SUCCEEDED'
      })),
      err => {
        // The trigger would also refuse this; the service names both states so
        // the caller gets a 409 rather than a check_violation as a 500.
        assert.equal(err.statusCode, 409);
        assert.match(err.message, /CANCELLED.*SUCCEEDED/);
        return true;
      }
    );
  });

  it('requires a rate when the tender is not VES', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    // USD cash against a bolívar bill is routine here; recording the amount
    // without the rate it was converted at leaves the till unreconcilable.
    await assert.rejects(
      () => db.query(
        `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type, tendered_currency, tendered_amount)
         VALUES ($1,$2,'75754','SUCCEEDED','CASH','STAFF','USD','1000')`,
        [restaurant.id, bill.id]
      ),
      err => {
        assert.equal(err.code, '23514', 'check_violation');
        return true;
      }
    );

    const ok = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type, tendered_currency, tendered_amount, tendered_fx_rate)
       VALUES ($1,$2,'75754','SUCCEEDED','CASH','STAFF','USD','1000','757.540600') RETURNING tendered_fx_rate`,
      [restaurant.id, bill.id]
    );
    assert.equal(Number(ok.rows[0].tendered_fx_rate), 757.5406);
  });

  it('will not let a bill with payments be deleted', async () => {
    const bill = await freshBill({ totalDue: 5000 });
    await processSplitPayment({ restaurantId: restaurant.id, billId: bill.id, amountPaidMinorUnits: 100 });

    await assert.rejects(
      () => db.query('DELETE FROM bills WHERE id = $1', [bill.id]),
      err => {
        assert.equal(err.code, '23503', 'foreign_key_violation');
        return true;
      }
    );
  });
});
