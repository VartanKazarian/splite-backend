const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { applyToBill, settlementView, toPaymentAmount } = require('./locks');
const { recordPayment, transitionPayment } = require('./payments');
const { MercantilC2PClient, MercantilC2PError } = require('../payments/providers/mercantil/c2p');
const { matchInDoubtPayment, OUTCOME, digitsOnly } = require('./c2pMatcher');
const { logAudit } = require('./audit');
const { logger } = require('../connectors/logger');

/**
 * Mercantil C2P: raising a charge, and resolving one the bank never answered.
 *
 * This is the first rail where Splite initiates the movement, and that single
 * difference is where all the difficulty lives. A Pago Móvil claim and a
 * webhook are both reports about money that has already moved; here we ask for
 * money to move and may never be told what happened. Mercantil does not promise
 * that `invoice_number` deduplicates, so "we do not know" cannot be collapsed
 * into "it failed" -- a diner told their payment was declined will pay again,
 * and if the first debit landed they have now paid twice.
 *
 * IN_DOUBT is that state, and it settles nothing: `bills.amount_paid_ves` is
 * untouched, exactly as it is for a PENDING claim. `resolveC2PPayment` is how
 * it ends, and getting it right means three things the obvious version misses:
 *
 *   1. LOCK THE ROW. There are seconds of HTTP between reading the payment and
 *      settling it. Without FOR UPDATE two cashiers pressing "resolve" both see
 *      IN_DOUBT and the bill is credited twice.
 *   2. IDENTIFY THE PAYER. Matching a bank movement on amount alone settles one
 *      table with another table's money. See services/c2pMatcher.js.
 *   3. SPEND THE REFERENCE EXACTLY ONCE. The bank reference is written to
 *      `payments.provider_payment_id`, which carries a unique index, so a
 *      second resolution claiming the same movement loses on 23505 and unwinds.
 *
 * No network call ever happens inside a transaction. The bank is asked first,
 * the transaction opens afterwards and re-checks everything it was told.
 */

/** How far back the bank is asked for movements. Beyond this it is archaeology. */
const RESOLUTION_WINDOW_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * How long a missing movement means "not yet" rather than "never".
 *
 * Below this age, absence proves nothing: interbank settlement is not instant,
 * and failing a charge whose debit is still in flight is the same double-charge
 * error in slower motion.
 */
const SETTLEMENT_WINDOW_MINUTES = 15;

/** The bank is asked from slightly before the charge, for clock skew between us and them. */
const SEARCH_LEAD_MS = 5 * 60 * 1000;

const PROVIDER = 'MERCANTIL';

/** Mercantil's correlation id for the charge. Not an idempotency key -- see migration 019. */
const invoiceFor = paymentId => `SPL-${paymentId.replace(/-/g, '').slice(0, 24)}`;

/** Four digits of the payer's phone: enough to tell two diners apart, not enough to be a number. */
const lastFour = phone => digitsOnly(phone).slice(-4).padStart(4, '0');

/**
 * The bank reference, which is what one payment may spend exactly once.
 *
 * Prefers the reference over the provider's own payment id because the
 * reference is what appears in the movement list, on the diner's receipt and in
 * a dispute. Falling back to the payment id keeps the uniqueness guarantee
 * rather than writing null and losing it.
 */
const referenceFor = result => result.bankReference || result.providerPaymentId || null;

/** Evidence of an attempt, including the ones that deliberately settle nothing. */
async function logAttempt(client, { paymentId, restaurantId, outcome, candidates = [], reason = null, actorUserId = null }) {
  await client.query(
    `INSERT INTO c2p_resolution_attempts (payment_id, restaurant_id, outcome, candidate_refs, reason, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [paymentId, restaurantId, outcome, JSON.stringify(candidates), reason, actorUserId]
  );
}

/**
 * Turns a unique violation on the reference index into the 409 a client can read.
 *
 * The index is what makes the guarantee; this only makes it legible. Anything
 * else is rethrown untouched.
 */
function asReferenceConflict(err, reference) {
  if (err.code === '23505' && String(err.constraint || '').includes('provider_reference')) {
    return new ApiError(
      'PAYMENT_REFERENCE_ALREADY_USED',
      'That bank movement has already settled another payment',
      { reference }
    );
  }
  return err;
}

/**
 * Raise a C2P charge against the diner's bank.
 *
 * The payment row is written and committed *before* the bank is called, so a
 * charge can never exist at Mercantil with no trace on our side. The reverse
 * -- a PENDING row for a call that never happened -- is recoverable; the
 * other direction is money we cannot account for.
 */
async function createC2PPayment({
  restaurantId, billId, amountVes, payer, idempotencyKey = null, payerId = null,
  // The bank client is injectable so the settlement and idempotency guarantees
  // can be exercised against a real Postgres without a real Mercantil. Nothing
  // in production passes it; the default binds this restaurant's sealed
  // credentials.
  bankClient = null
}) {
  const amount = toPaymentAmount(amountVes);
  if (amount === null) throw new ApiError('INVALID_AMOUNT', 'Invalid payment amount');

  // Built before anything is written: a misconfigured rail must fail without
  // leaving a PENDING payment nobody will ever resolve.
  const client = bankClient ?? await MercantilC2PClient.forRestaurant(restaurantId);

  const { payment, invoiceNumber } = await db.withTransaction(async tx => {
    const { rows } = await tx.query(
      `SELECT id, status, total_due_ves, amount_paid_ves
         FROM bills WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [billId, restaurantId]
    );
    const bill = rows[0];
    if (!bill) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
    if (bill.status !== 'OPEN') {
      throw new ApiError('BILL_NOT_OPEN', 'Bill is not open', { status: bill.status });
    }

    // Checked here so the diner is refused before the bank is troubled, and
    // checked again by applyToBill at settlement because the balance can move
    // while the charge is in flight.
    const remaining = BigInt(bill.total_due_ves) - BigInt(bill.amount_paid_ves);
    if (amount > remaining) {
      throw new ApiError('PAYMENT_EXCEEDS_BALANCE', 'Payment exceeds remaining bill balance', {
        remainingVes: remaining.toString()
      });
    }

    const created = await recordPayment(tx, {
      restaurantId,
      billId,
      amountVes: amount,
      status: 'PENDING',
      paymentMethod: 'C2P',
      provider: PROVIDER,
      idempotencyKey,
      payerType: 'GUEST',
      payerId,
      reason: 'C2P charge submitted to Mercantil'
    });

    const invoice = invoiceFor(created.id);
    await tx.query(
      `INSERT INTO c2p_charges (payment_id, restaurant_id, invoice_number, payer_bank_code, payer_phone_last4)
       VALUES ($1, $2, $3, $4, $5)`,
      [created.id, restaurantId, invoice, payer.bankCode, lastFour(payer.phone)]
    );

    return { payment: created, invoiceNumber: invoice };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

  let result;
  try {
    result = await client.charge({ invoiceNumber, amountVesMinor: amount, payer });
  } catch (err) {
    if (err instanceof MercantilC2PError && err.code === 'BANK_INDETERMINATE') {
      // The only honest answer. Not an error to the caller: the charge exists,
      // it has an id, and it has a resolution path.
      await moveTo(payment, restaurantId, 'IN_DOUBT', 'Mercantil returned no conclusive response');
      logger.warn(
        { event: 'C2P_CHARGE_IN_DOUBT', paymentId: payment.id, restaurantId, billId },
        'C2P charge left in doubt'
      );
      return { paymentId: payment.id, status: 'IN_DOUBT', invoiceNumber, requiresResolution: true };
    }

    // A deliberate rejection by the bank, or a request we built wrongly. Either
    // way no debit was applied, so the payment is closed off as failed.
    await moveTo(payment, restaurantId, 'FAILED', 'Rejected by Mercantil');
    return {
      paymentId: payment.id,
      status: 'FAILED',
      invoiceNumber,
      reason: err instanceof MercantilC2PError ? err.message : 'Charge could not be completed'
    };
  } finally {
    // The clave is single-use and has now been used or wasted. Dropping the
    // reference here keeps it out of anything that later serialises the payer
    // object -- an error report, a retry, a log line somebody adds in a year.
    if (payer) payer.clave = undefined;
  }

  if (result.status !== 'SUCCEEDED') {
    await moveTo(payment, restaurantId, 'FAILED', result.reason || 'Rejected by Mercantil');
    return { paymentId: payment.id, status: 'FAILED', invoiceNumber, reason: result.reason ?? null };
  }

  const reference = referenceFor(result);

  let settlement;
  try {
    settlement = await db.withTransaction(async tx => {
      if (reference) {
        await tx.query(
          `UPDATE payments SET provider_payment_id = $1 WHERE id = $2 AND restaurant_id = $3`,
          [reference, payment.id, restaurantId]
        );
      }
      const applied = await applyToBill(tx, { restaurantId, billId, amount });
      await transitionPayment(tx, {
        paymentId: payment.id, restaurantId, toStatus: 'SUCCEEDED',
        reason: 'Confirmed by Mercantil', actorType: 'PROVIDER'
      });
      await tx.query('UPDATE c2p_charges SET last_resolution_at = NOW() WHERE payment_id = $1', [payment.id]);
      return { ...settlementView(applied.bill, applied), paymentId: payment.id };
    }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
  } catch (err) {
    // The bank confirmed the debit and we cannot apply it. The usual cause is
    // that the bill closed or was voided during the seconds the charge was in
    // flight; a reference the bank has already used elsewhere lands here too.
    //
    // This must not reach the caller as a failure. The diner has been debited,
    // and a thrown error would release the idempotency key and invite the retry
    // that charges them a second time. So the charge is parked in the same
    // queue as an unattributable movement -- the money is real, its destination
    // is a decision -- and returned as a normal result.
    return parkUnappliable({ payment, restaurantId, billId, invoiceNumber, reference, err });
  }

  await logAudit({
    restaurantId,
    action: 'C2P_CHARGE_SETTLED',
    resourceType: 'payment',
    resourceId: payment.id,
    details: { billId, billStatus: settlement.status }
  });

  return { paymentId: payment.id, status: 'SUCCEEDED', invoiceNumber, bankReference: reference, settlement };
}

/**
 * A confirmed debit that could not be credited to its bill.
 *
 * Moves the payment to AMBIGUOUS and records why, so it appears in the same
 * queue staff already work. Deliberately never throws: it runs on a path where
 * the diner's money has already moved, and the caller's only safe options are
 * to report the charge or to report the charge.
 */
async function parkUnappliable({ payment, restaurantId, billId, invoiceNumber, reference, err }) {
  const conflict = asReferenceConflict(err, reference);
  const referenceTaken = conflict instanceof ApiError && conflict.code === 'PAYMENT_REFERENCE_ALREADY_USED';
  const reason = conflict instanceof ApiError
    ? conflict.message
    : 'Bank confirmed the debit but it could not be applied to the bill';

  logger.error(
    { event: 'C2P_CHARGE_UNAPPLIABLE', paymentId: payment.id, restaurantId, billId, reference, err },
    'Mercantil confirmed a debit that could not be applied to its bill'
  );

  try {
    await db.withTransaction(async tx => {
      // Record the reference the debit carried, so the movement is marked spent
      // and staff have it for the refund -- unless it was a reference conflict,
      // where another payment already owns it and writing it would collide with
      // the same unique index all over again.
      if (reference && !referenceTaken) {
        await tx.query(
          `UPDATE payments SET provider_payment_id = $1 WHERE id = $2 AND restaurant_id = $3`,
          [reference, payment.id, restaurantId]
        );
      }
      await transitionPayment(tx, {
        paymentId: payment.id, restaurantId, toStatus: 'AMBIGUOUS',
        reason: reason.slice(0, 200), actorType: 'PROVIDER'
      });
    });
  } catch (transitionErr) {
    // Even this failing changes nothing for the caller: the payment row exists,
    // it is not settled, and the queue reads status rather than trusting that
    // this write landed.
    logger.error(
      { event: 'C2P_PARK_FAILED', paymentId: payment.id, restaurantId, err: transitionErr },
      'Could not park an unappliable C2P charge'
    );
  }

  await logAudit({
    restaurantId,
    action: 'C2P_CHARGE_UNAPPLIABLE',
    resourceType: 'payment',
    resourceId: payment.id,
    details: { billId, reference, reason }
  });

  return {
    paymentId: payment.id,
    status: 'AMBIGUOUS',
    invoiceNumber,
    bankReference: reference,
    reason,
    requiresStaffReview: true
  };
}

/** A status move on its own transaction, for the paths that settle nothing. */
function moveTo(payment, restaurantId, toStatus, reason) {
  return db.withTransaction(tx =>
    transitionPayment(tx, { paymentId: payment.id, restaurantId, toStatus, reason, actorType: 'PROVIDER' }));
}

/**
 * Ask the bank what actually happened to an in-doubt charge.
 *
 * Staff-initiated today. A scheduled sweep would call exactly this with
 * `actorUserId` null, which is why nothing here reads a request.
 */
async function resolveC2PPayment({ restaurantId, paymentId, actorUserId = null, bankClient = null }) {
  const { rows } = await db.query(
    `SELECT p.id, p.status, p.bill_id, p.amount_ves, p.created_at,
            c.invoice_number, c.payer_bank_code, c.payer_phone_last4
       FROM payments p
       JOIN c2p_charges c ON c.payment_id = p.id
      WHERE p.id = $1 AND p.restaurant_id = $2`,
    [paymentId, restaurantId]
  );
  const payment = rows[0];
  if (!payment) throw new ApiError('PAYMENT_CLAIM_NOT_FOUND', 'C2P charge not found');

  // AMBIGUOUS is deliberately not re-resolvable: the system has already said it
  // cannot tell these movements apart, and asking again will not change that.
  // Only a person leaves that state.
  if (payment.status !== 'IN_DOUBT') {
    return { paymentId: payment.id, status: payment.status, alreadyResolved: true };
  }

  const createdMs = new Date(payment.created_at).getTime();
  const ageMinutes = (Date.now() - createdMs) / 60000;

  // Bounded on both ends: never before the charge, never more than six hours
  // back however old the charge is.
  const from = new Date(Math.max(createdMs - SEARCH_LEAD_MS, Date.now() - RESOLUTION_WINDOW_MAX_MS));

  let movements;
  try {
    const bank = bankClient ?? await MercantilC2PClient.forRestaurant(restaurantId);
    movements = await bank.search({
      fromDate: from.toISOString(),
      toDate: new Date().toISOString(),
      amountVesMinor: payment.amount_ves
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // The charge stays IN_DOUBT and the question can be asked again. Inventing
    // an outcome from a failed HTTP call is the one thing this must never do.
    throw new ApiError('PAYMENT_RESOLUTION_UNAVAILABLE', 'Could not reach Mercantil to resolve this charge', {
      retryAfterSeconds: 60
    });
  }

  // Which of those movements have already settled something. Looked up by the
  // references actually returned, so this is an index probe rather than a scan
  // of the ledger.
  const references = movements.map(m => digitsOnly(m.reference)).filter(Boolean);
  const consumed = new Set(
    references.length
      ? (await db.query(
        `SELECT provider_payment_id FROM payments
          WHERE provider = $1 AND provider_payment_id = ANY($2::text[])`,
        [PROVIDER, references]
      )).rows.map(r => digitsOnly(r.provider_payment_id))
      : []
  );

  const match = matchInDoubtPayment(movements, payment, consumed);

  try {
    return await db.withTransaction(async tx => {
      // Re-read under lock. Another resolve -- or a webhook, or a scheduled
      // sweep -- may have finished while we were waiting on the bank, and
      // everything decided above was decided against a stale row.
      const locked = (await tx.query(
        `SELECT id, status, bill_id, amount_ves FROM payments
          WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
        [paymentId, restaurantId]
      )).rows[0];

      if (locked.status !== 'IN_DOUBT') {
        await logAttempt(tx, {
          paymentId, restaurantId, outcome: 'ALREADY_RESOLVED',
          reason: `Resolved as ${locked.status} while the bank was being queried`, actorUserId
        });
        return { paymentId, status: locked.status, alreadyResolved: true };
      }

      await tx.query('UPDATE c2p_charges SET last_resolution_at = NOW() WHERE payment_id = $1', [paymentId]);

      if (match.outcome === OUTCOME.MATCHED) {
        const reference = digitsOnly(match.movement.reference);

        // Claimed first: on conflict the settlement below never happens.
        await tx.query(
          `UPDATE payments SET provider_payment_id = $1 WHERE id = $2 AND restaurant_id = $3`,
          [reference, paymentId, restaurantId]
        );

        const applied = await applyToBill(tx, {
          restaurantId, billId: locked.bill_id, amount: BigInt(locked.amount_ves)
        });
        await transitionPayment(tx, {
          paymentId, restaurantId, toStatus: 'SUCCEEDED',
          reason: 'Matched to a bank movement on amount and payer phone',
          actorType: actorUserId ? 'STAFF' : 'SYSTEM', actorId: actorUserId
        });

        await logAttempt(tx, {
          paymentId, restaurantId, outcome: 'MATCHED', candidates: [reference], actorUserId
        });

        return {
          paymentId, status: 'SUCCEEDED', bankReference: reference, signals: match.signals,
          settlement: { ...settlementView(applied.bill, applied), paymentId }
        };
      }

      if (match.outcome === OUTCOME.AMBIGUOUS) {
        // The bank holds money for this amount and nothing ties it to this
        // diner. Settling would close somebody's bill with somebody else's
        // money, so this stops and hands the candidates to a person.
        await transitionPayment(tx, {
          paymentId, restaurantId, toStatus: 'AMBIGUOUS', reason: match.reason,
          actorType: actorUserId ? 'STAFF' : 'SYSTEM', actorId: actorUserId
        });
        await logAttempt(tx, {
          paymentId, restaurantId, outcome: 'AMBIGUOUS',
          candidates: match.candidates, reason: match.reason, actorUserId
        });
        return {
          paymentId, status: 'AMBIGUOUS', reason: match.reason,
          candidateReferences: match.candidates, requiresStaffReview: true
        };
      }

      // NO_MATCH. Before the settlement window closes, absence is not evidence.
      if (ageMinutes < SETTLEMENT_WINDOW_MINUTES) {
        await logAttempt(tx, {
          paymentId, restaurantId, outcome: 'PENDING_WINDOW',
          reason: 'Still inside the settlement window', actorUserId
        });
        return {
          paymentId, status: 'IN_DOUBT', resolutionPending: true,
          retryAfterMinutes: Math.ceil(SETTLEMENT_WINDOW_MINUTES - ageMinutes)
        };
      }

      await transitionPayment(tx, {
        paymentId, restaurantId, toStatus: 'FAILED',
        reason: 'No matching movement after the settlement window',
        actorType: actorUserId ? 'STAFF' : 'SYSTEM', actorId: actorUserId
      });
      await logAttempt(tx, {
        paymentId, restaurantId, outcome: 'NO_MATCH',
        reason: 'No matching movement after the settlement window', actorUserId
      });
      return { paymentId, status: 'FAILED', safeToRetry: true };
    }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
  } catch (err) {
    throw asReferenceConflict(err, match.movement ? digitsOnly(match.movement.reference) : null);
  }
}

/**
 * Charges waiting on a human or on the settlement window.
 *
 * The queue the AMBIGUOUS state implies. Without somewhere to see them, a
 * charge that refuses to guess is indistinguishable from one that was lost.
 */
async function listUnresolved({ restaurantId, limit = 50 }) {
  const { rows } = await db.query(
    `SELECT p.id, p.bill_id, p.amount_ves, p.status, p.payment_method,
            p.created_at, p.updated_at,
            c.invoice_number, c.payer_bank_code, c.payer_phone_last4, c.last_resolution_at,
            (SELECT a.candidate_refs FROM c2p_resolution_attempts a
              WHERE a.payment_id = p.id ORDER BY a.attempted_at DESC LIMIT 1) AS candidate_refs,
            (SELECT a.reason FROM c2p_resolution_attempts a
              WHERE a.payment_id = p.id ORDER BY a.attempted_at DESC LIMIT 1) AS last_reason
       FROM payments p
       JOIN c2p_charges c ON c.payment_id = p.id
      WHERE p.restaurant_id = $1 AND p.status IN ('IN_DOUBT', 'AMBIGUOUS')
      ORDER BY p.created_at ASC
      LIMIT $2`,
    [restaurantId, limit]
  );
  return rows;
}

module.exports = {
  createC2PPayment,
  resolveC2PPayment,
  listUnresolved,
  RESOLUTION_WINDOW_MAX_MS,
  SETTLEMENT_WINDOW_MINUTES,
  invoiceFor,
  lastFour,
  referenceFor
};
