const { getContext, logger } = require('../connectors/logger');
const { ApiError } = require('../errors');
const { advanceShare } = require('./splits');

/**
 * The payment ledger.
 *
 * Every write here happens on a caller-supplied client, never on the pool, so
 * the ledger row, its transition and the `bills.amount_paid_ves` cache all land in
 * one transaction. A payment recorded outside the transaction that moved the
 * money would be exactly the drift this table exists to make impossible.
 */

const PAYMENT_COLUMNS = `id, restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method,
                         provider, provider_payment_id, declared_reference, idempotency_key,
                         payer_type, payer_id, split_participant_id,
                         tendered_amount, tendered_currency, tendered_fx_rate,
                         metadata, created_at, updated_at`;

/**
 * Legal transitions, mirroring the trigger in migrations 007 and 019.
 *
 * Duplicated on purpose: the database is the guarantee, this is the error
 * message. Rejecting here gives a 409 naming both states instead of a
 * check_violation surfacing as a 500.
 *
 * The duplication is only safe while the two agree, so `test/c2p.test.js`
 * parses the trigger out of the migration and compares it to this object. The
 * first time they disagreed, the trigger had gained IN_DOUBT and this had not,
 * which made every C2P charge fail at the service layer with a 409 naming a
 * transition the database would happily have performed.
 */
// A payment is "settled" -- money has moved and the bill was advanced -- only
// as SUCCEEDED. Its refund descendants have not moved new money, so a share is
// credited on the way into SUCCEEDED and never again.
const SETTLED_STATUSES = new Set(['SUCCEEDED']);

/**
 * The ways a share can permanently refuse money that has already moved.
 *
 * Every one is a settled fact -- the plan went stale, was voided, or the share
 * is already paid -- so retrying cannot change it. What the caller should *do*
 * about it differs by rail, which is why `onShareRefusal` exists rather than a
 * single answer baked in here: a C2P charge we initiated is parked for a person
 * to refund, while a Pago Movil a member of staff has already found in the bank
 * app is money that indisputably arrived and belongs on the bill.
 */
const SHARE_REFUSALS = new Set([
  'SPLIT_STALE', 'SPLIT_NOT_ACTIVE', 'SPLIT_SHARE_OVERPAID', 'SPLIT_SHARE_NOT_FOUND'
]);

const ALLOWED_TRANSITIONS = {
  // IN_DOUBT and AMBIGUOUS belong to provider-initiated rails: we asked a bank
  // to move money and were not told whether it did (IN_DOUBT), or money exists
  // that we cannot attribute to this bill (AMBIGUOUS). Neither settles
  // anything, so `bills.amount_paid_ves` is untouched in both -- see
  // migration 019.
  PENDING: ['IN_DOUBT', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED', 'CANCELLED'],
  IN_DOUBT: ['AMBIGUOUS', 'SUCCEEDED', 'FAILED'],
  // Only a person leaves AMBIGUOUS. The system has already reported that it
  // cannot tell the candidates apart.
  AMBIGUOUS: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: []
};



/** Records a transition. Append-only; nothing here is ever updated. */
async function appendTransition(client, {
  paymentId, restaurantId, fromStatus, toStatus, reason = null, actorType = 'SYSTEM', actorId = null
}) {
  await client.query(
    `INSERT INTO payment_transitions
       (payment_id, restaurant_id, from_status, to_status, reason, actor_type, actor_id, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [paymentId, restaurantId, fromStatus, toStatus, reason, actorType, actorId, getContext().requestId ?? null]
  );
}

/**
 * Writes a payment and its opening transition.
 *
 * Platform payments are synchronous — the money has already moved by the time
 * this runs — so they are recorded as SUCCEEDED. PENDING exists for providers
 * that confirm out of band.
 */
async function recordPayment(client, {
  restaurantId,
  billId,
  amountVes,
  status = 'SUCCEEDED',
  paymentMethod = 'SPLITE',
  provider = null,
  providerPaymentId = null,
  // A payer's own transcription of their bank reference. Distinct from
  // providerPaymentId, which is an identifier a system handed us; this one is
  // typed by a human off a receipt and may simply be wrong.
  declaredReference = null,
  idempotencyKey = null,
  payerType = 'STAFF',
  payerId = null,
  /**
   * A voluntary tip, on top of what this payment settles.
   *
   * Deliberately not added to `amountVes`: that figure is the part of the bill
   * being paid, and the bill's ceiling, its CLOSED-on-equality rule and the
   * drift view are all defined against it. The payer handed over
   * `amountVes + tipVes`; only the first half is the bill's business.
   */
  tipVes = 0,
  // When set, this payment settles one participant's share of a persistent
  // split. The share is advanced below, in this same transaction, once the
  // payment is in a settled state -- see advanceShare.
  splitParticipantId = null,
  tendered = null,
  metadata = null,
  reason = null
}) {
  const { rows } = await client.query(
    `INSERT INTO payments
       (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method,
        provider, provider_payment_id, declared_reference, idempotency_key,
        payer_type, payer_id, split_participant_id,
        tendered_amount, tendered_currency, tendered_fx_rate, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING ${PAYMENT_COLUMNS}`,
    [
      restaurantId,
      billId,
      String(amountVes),
      String(tipVes ?? 0),
      status,
      paymentMethod,
      provider,
      providerPaymentId,
      declaredReference,
      idempotencyKey,
      payerType,
      payerId,
      splitParticipantId,
      tendered?.amount != null ? String(tendered.amount) : null,
      tendered?.currency ?? null,
      tendered?.fxRate ?? null,
      metadata ? JSON.stringify(metadata) : null
    ]
  );

  const payment = rows[0];
  await appendTransition(client, {
    paymentId: payment.id,
    restaurantId,
    fromStatus: null,
    toStatus: status,
    reason,
    actorType: payerType === 'SYSTEM' ? 'SYSTEM' : payerType,
    actorId: payerId
  });

  // A payment written already settled -- a staff platform payment -- credits its
  // share here. One written PENDING (a claim, a C2P charge) credits it later,
  // when transitionPayment moves it to SUCCEEDED.
  if (splitParticipantId && SETTLED_STATUSES.has(status)) {
    await advanceShare(client, { splitParticipantId, restaurantId, amountVes, billId });
  }

  return payment;
}

/**
 * Moves a payment to a new status and records the move.
 *
 * The row is locked first: two callers confirming the same provider callback
 * would otherwise both read PENDING and both try to settle it.
 */
async function transitionPayment(client, {
  paymentId, restaurantId, toStatus, reason = null, actorType = 'SYSTEM', actorId = null,
  /**
   * What to do when the share cannot take this money.
   *
   * 'THROW' (the default, and every existing caller) surfaces the refusal so
   * the rail decides -- the C2P resolver parks the charge for a person.
   * 'DETACH' credits the bill and drops the attribution, for money whose
   * arrival is not in question.
   */
  onShareRefusal = 'THROW'
}) {
  const { rows } = await client.query(
    `SELECT id, status, split_participant_id, amount_ves, bill_id FROM payments
      WHERE id = $1 AND restaurant_id = $2
      FOR UPDATE`,
    [paymentId, restaurantId]
  );
  const current = rows[0];
  if (!current) {
    throw new ApiError('NOT_FOUND', 'Payment not found');
  }

  if (current.status === toStatus) return current;

  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(toStatus)) {
    throw new ApiError(
      'PAYMENT_STATE_INVALID',
      `Cannot move a ${current.status} payment to ${toStatus}`,
      { from: current.status, to: toStatus }
    );
  }

  const updated = await client.query(
    `UPDATE payments SET status = $1 WHERE id = $2 AND restaurant_id = $3
     RETURNING ${PAYMENT_COLUMNS}`,
    [toStatus, paymentId, restaurantId]
  );

  await appendTransition(client, {
    paymentId,
    restaurantId,
    fromStatus: current.status,
    toStatus,
    reason,
    actorType,
    actorId
  });

  // Settling a payment that names a share credits that share, in the same
  // transaction that moved the money. Only on the way *into* a settled state,
  // so a later refund transition does not double-credit.
  if (current.split_participant_id && SETTLED_STATUSES.has(toStatus)) {
    // Inside a SAVEPOINT because a refusal is not always a clean throw: the
    // overpaid case is a CHECK violation, which aborts the transaction, and
    // every statement after it would fail with 25P02. Without this, "handle the
    // refusal" is not something a caller can do at all.
    await client.query('SAVEPOINT advance_share');
    try {
      await advanceShare(client, {
        splitParticipantId: current.split_participant_id,
        restaurantId,
        amountVes: current.amount_ves,
        billId: current.bill_id
      });
      await client.query('RELEASE SAVEPOINT advance_share');
    } catch (err) {
      if (onShareRefusal !== 'DETACH' || !SHARE_REFUSALS.has(err.code)) throw err;

      await client.query('ROLLBACK TO SAVEPOINT advance_share');
      // The money is on the bill; only the attribution is impossible. Clearing
      // the column rather than leaving it set is what keeps
      // `bill_split_share_drift` honest -- a settled payment still naming a
      // share it never credited reads there as permanent drift.
      await client.query(
        'UPDATE payments SET split_participant_id = NULL WHERE id = $1 AND restaurant_id = $2',
        [paymentId, restaurantId]
      );
      logger.warn(
        {
          event: 'PAYMENT_SHARE_DETACHED',
          paymentId, restaurantId, code: err.code,
          splitParticipantId: current.split_participant_id
        },
        'Settled a payment against the bill after its share refused it'
      );
      return { ...updated.rows[0], split_participant_id: null, shareDetached: err.code };
    }
  }

  return updated.rows[0];
}

/** The ledger for a bill, oldest first. */
async function listForBill(db, { restaurantId, billId }) {
  const { rows } = await db.query(
    `SELECT ${PAYMENT_COLUMNS} FROM payments
      WHERE restaurant_id = $1 AND bill_id = $2
      ORDER BY created_at ASC`,
    [restaurantId, billId]
  );
  return rows;
}

module.exports = {
  recordPayment,
  transitionPayment,
  appendTransition,
  listForBill,
  ALLOWED_TRANSITIONS,
  PAYMENT_COLUMNS
};
