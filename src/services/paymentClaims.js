const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { applyToBill, settlementView, toPaymentAmount } = require('./locks');
const { recordPayment, transitionPayment, PAYMENT_COLUMNS } = require('./payments');
const { logAudit } = require('./audit');
const { logger } = require('../connectors/logger');

/**
 * Declared payments: "I paid by Pago Móvil, here is my reference."
 *
 * Splite never touches this money. It goes from the diner's bank account to the
 * restaurant's, and no API of ours can see it arrive. So the honest model is
 * that a diner's word creates a *claim*, and a person at the restaurant — who
 * can look at the bank app on the till — turns it into a payment.
 *
 * The claim is a `payments` row in PENDING. That matters more than it looks:
 *
 *  - `bills.amount_paid_ves` is untouched while a claim is pending. Pending
 *    money is not received money, and a bill that shows itself as paid because
 *    somebody typed a number into a form is worse than one that shows nothing.
 *  - PENDING → SUCCEEDED is already a legal transition with a trigger behind it
 *    and an append-only log in front of it. A separate `payment_claims` table
 *    would be a second answer to "what has this bill been paid", and the two
 *    would disagree eventually.
 *
 * This is deliberately not automatic reconciliation. Reading a restaurant's
 * bank feed and matching movements to tables is a real thing to build, but it
 * needs a banking relationship per restaurant. This needs a waiter with a
 * phone, and it works tomorrow.
 */

/** Digits only: a reference is transcribed by hand and arrives spaced, dashed and padded. */
const normaliseReference = value => String(value ?? '').replace(/\D/g, '');

/**
 * A diner declares a payment.
 *
 * Anyone holding a guest session for the table can call this, which is the
 * correct trust level: it asserts nothing and settles nothing. The claim is a
 * message to the restaurant, and the restaurant decides.
 */
async function declareClaim({
  restaurantId, billId, amountVes, reference, phoneOrigin, bankOrigin,
  payer = { type: 'GUEST', id: null }, splitParticipantId = null, tipVes = 0, meta = {}
}) {
  const amount = toPaymentAmount(amountVes);
  if (amount === null) throw new ApiError('INVALID_AMOUNT', 'Invalid payment amount');

  const declaredReference = normaliseReference(reference);

  try {
    const claim = await db.withTransaction(async client => {
      // The bill is read under lock and checked, so a claim cannot be attached
      // to a closed or voided bill. Nothing is written to it.
      const { rows } = await client.query(
        `SELECT id, status, total_due_ves, amount_paid_ves
           FROM bills WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
        [billId, restaurantId]
      );
      const bill = rows[0];
      if (!bill) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
      if (bill.status !== 'OPEN') {
        throw new ApiError('BILL_NOT_OPEN', 'Bill is not open', { status: bill.status });
      }

      // Checked here as a courtesy so a diner is told immediately, and checked
      // again at confirmation because a claim is not a reservation: two diners
      // may each claim the whole balance and only the first confirmation can
      // succeed.
      const remaining = BigInt(bill.total_due_ves) - BigInt(bill.amount_paid_ves);
      if (amount > remaining) {
        throw new ApiError('PAYMENT_EXCEEDS_BALANCE', 'Payment exceeds remaining bill balance', {
          remainingVes: remaining.toString()
        });
      }

      return recordPayment(client, {
        restaurantId,
        billId,
        amountVes: amount,
        status: 'PENDING',
        paymentMethod: 'PAGO_MOVIL',
        declaredReference: declaredReference || null,
        payerType: payer.type,
        payerId: payer.id,
        // Declared alongside the amount: the diner says they sent bill + tip in
        // one transfer, and staff verify the total against the bank app.
        tipVes,
        // Carried on the row so that, when a staff member confirms the claim,
        // the same transition that settles it credits this share.
        splitParticipantId,
        // Everything the person verifying it needs in order to find the movement
        // in the bank app, and nothing that pretends to be proof.
        metadata: {
          phoneOrigin: phoneOrigin ?? null,
          bankOrigin: bankOrigin ?? null,
          declaredAt: new Date().toISOString()
        },
        reason: 'Declared by payer, awaiting verification'
      });
    });

    await logAudit({
      restaurantId,
      action: 'PAYMENT_CLAIM_DECLARED',
      resourceType: 'payment',
      resourceId: claim.id,
      details: { billId, amountVes: amount.toString() },
      ...meta
    });

    return claim;
  } catch (err) {
    // The partial unique index in migration 014. Someone has already claimed
    // this reference on this restaurant, and it is not necessarily this diner's
    // fault -- a mistyped digit collides too.
    if (err.code === '23505' && String(err.constraint || '').includes('declared_reference')) {
      throw new ApiError(
        'PAYMENT_REFERENCE_ALREADY_USED',
        'That reference has already been used to declare a payment'
      );
    }
    throw err;
  }
}

/** Claims awaiting a human, newest last so the queue reads top to bottom. */
async function listClaims({ restaurantId, billId = null, status = 'PENDING', limit = 50 }) {
  const { rows } = await db.query(
    `SELECT ${PAYMENT_COLUMNS}
       FROM payments
      WHERE restaurant_id = $1
        AND payment_method = 'PAGO_MOVIL'
        AND ($2::uuid IS NULL OR bill_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at ASC
      LIMIT $4`,
    [restaurantId, billId, status, limit]
  );
  return rows;
}

/**
 * A member of staff says the money is there.
 *
 * This is the moment the bill actually moves, and it goes through `applyToBill`
 * — the same function a staff split and a provider webhook use — so a confirmed
 * claim cannot overpay a bill or close one that was voided while it sat in the
 * queue.
 */
async function confirmClaim({ restaurantId, claimId, actor, meta = {} }) {
  const result = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, bill_id, amount_ves, status, payment_method
         FROM payments
        WHERE id = $1 AND restaurant_id = $2
        FOR UPDATE`,
      [claimId, restaurantId]
    );
    const claim = rows[0];
    if (!claim || claim.payment_method !== 'PAGO_MOVIL') {
      throw new ApiError('PAYMENT_CLAIM_NOT_FOUND', 'Payment claim not found');
    }
    if (claim.status !== 'PENDING') {
      throw new ApiError('PAYMENT_CLAIM_NOT_PENDING', 'That claim has already been resolved', {
        status: claim.status
      });
    }

    const applied = await applyToBill(client, {
      restaurantId,
      billId: claim.bill_id,
      amount: BigInt(claim.amount_ves)
    });

    await transitionPayment(client, {
      paymentId: claim.id,
      restaurantId,
      toStatus: 'SUCCEEDED',
      reason: 'Verified against the restaurant bank account by staff',
      actorType: 'STAFF',
      actorId: actor?.id ?? null
    });

    return { ...settlementView(applied.bill, applied), paymentId: claim.id };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

  await logAudit({
    restaurantId,
    actorId: actor?.id ?? null,
    action: 'PAYMENT_CLAIM_CONFIRMED',
    resourceType: 'payment',
    resourceId: claimId,
    details: { billStatus: result.status, amountPaid: result.amountPaid },
    ...meta
  });

  logger.info({ event: 'PAYMENT_CLAIM_CONFIRMED', claimId, restaurantId }, 'Claim confirmed');

  return result;
}

/**
 * Staff cannot find the money.
 *
 * FAILED rather than deleted: a claim that was rejected is a thing that
 * happened, and if a diner insists they paid, the record of what they declared
 * and who rejected it is the only way to settle the argument. The partial
 * unique index excludes FAILED, so the reference is released and a diner who
 * simply mistyped can declare again.
 */
async function rejectClaim({ restaurantId, claimId, reason = null, actor, meta = {} }) {
  const claim = await db.withTransaction(async client => {
    // Guarded rather than transitioning straight to FAILED: without this,
    // "reject a claim" is an endpoint that can fail any payment in the
    // restaurant by id, including a settled card payment.
    const { rows } = await client.query(
      `SELECT id, status, payment_method FROM payments
        WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [claimId, restaurantId]
    );
    const existing = rows[0];
    if (!existing || existing.payment_method !== 'PAGO_MOVIL') {
      throw new ApiError('PAYMENT_CLAIM_NOT_FOUND', 'Payment claim not found');
    }
    if (existing.status !== 'PENDING') {
      throw new ApiError('PAYMENT_CLAIM_NOT_PENDING', 'That claim has already been resolved', {
        status: existing.status
      });
    }

    return transitionPayment(client, {
      paymentId: claimId,
      restaurantId,
      toStatus: 'FAILED',
      reason: reason || 'Not found in the restaurant bank account',
      actorType: 'STAFF',
      actorId: actor?.id ?? null
    });
  });

  await logAudit({
    restaurantId,
    actorId: actor?.id ?? null,
    action: 'PAYMENT_CLAIM_REJECTED',
    resourceType: 'payment',
    resourceId: claimId,
    details: { reason },
    ...meta
  });

  return claim;
}

module.exports = { declareClaim, listClaims, confirmClaim, rejectClaim, normaliseReference };
