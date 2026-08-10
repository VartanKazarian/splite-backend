const { getContext } = require('../connectors/logger');

/**
 * The payment ledger.
 *
 * Every write here happens on a caller-supplied client, never on the pool, so
 * the ledger row, its transition and the `bills.amount_paid` cache all land in
 * one transaction. A payment recorded outside the transaction that moved the
 * money would be exactly the drift this table exists to make impossible.
 */

const PAYMENT_COLUMNS = `id, restaurant_id, bill_id, amount_ves, status, payment_method,
                         provider, provider_payment_id, idempotency_key,
                         payer_type, payer_id,
                         tendered_amount, tendered_currency, tendered_fx_rate,
                         metadata, created_at, updated_at`;

/**
 * Legal transitions, mirroring the trigger in migration 007.
 *
 * Duplicated on purpose: the database is the guarantee, this is the error
 * message. Rejecting here gives a 409 naming both states instead of a
 * check_violation surfacing as a 500.
 */
const ALLOWED_TRANSITIONS = {
  PENDING: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: []
};

function conflict(message) {
  const error = new Error(message);
  error.statusCode = 409;
  return error;
}

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
  idempotencyKey = null,
  payerType = 'STAFF',
  payerId = null,
  tendered = null,
  metadata = null,
  reason = null
}) {
  const { rows } = await client.query(
    `INSERT INTO payments
       (restaurant_id, bill_id, amount_ves, status, payment_method,
        provider, provider_payment_id, idempotency_key,
        payer_type, payer_id,
        tendered_amount, tendered_currency, tendered_fx_rate, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${PAYMENT_COLUMNS}`,
    [
      restaurantId,
      billId,
      String(amountVes),
      status,
      paymentMethod,
      provider,
      providerPaymentId,
      idempotencyKey,
      payerType,
      payerId,
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

  return payment;
}

/**
 * Moves a payment to a new status and records the move.
 *
 * The row is locked first: two callers confirming the same provider callback
 * would otherwise both read PENDING and both try to settle it.
 */
async function transitionPayment(client, {
  paymentId, restaurantId, toStatus, reason = null, actorType = 'SYSTEM', actorId = null
}) {
  const { rows } = await client.query(
    `SELECT id, status FROM payments
      WHERE id = $1 AND restaurant_id = $2
      FOR UPDATE`,
    [paymentId, restaurantId]
  );
  const current = rows[0];
  if (!current) {
    const error = new Error('Payment not found');
    error.statusCode = 404;
    throw error;
  }

  if (current.status === toStatus) return current;

  const allowed = ALLOWED_TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(toStatus)) {
    throw conflict(`Cannot move a ${current.status} payment to ${toStatus}`);
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
