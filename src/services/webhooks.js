const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const verifyWebhookSignature = require('../middleware/webhookSignature');
const { applyToBill, settlementView } = require('./locks');
const { transitionPayment } = require('./payments');
const { logAudit } = require('./audit');
const { logger } = require('../connectors/logger');

/**
 * Inbound payment webhooks.
 *
 * Written provider-agnostically because Splite does not have an acquirer yet.
 * `PROVIDERS` maps a path segment to two functions -- how to authenticate a
 * delivery, and how to read one -- and adding a real acquirer means adding an
 * entry, not editing anything below it.
 *
 * The one provider defined today is `SPLITE`, whose scheme is our own HMAC. It
 * is not a placeholder: it is what a test harness, a manual replay, and any
 * future aggregator that lets us define the callback format will use.
 *
 * Three things this must get right, all of which are easy to get wrong:
 *
 *  1. The signature covers the **raw bytes**. `req.rawBody` is captured by the
 *     express.json verify hook in src/app.js for exactly this reason. Signing a
 *     re-serialised `req.body` compares an HMAC of our JSON formatting against
 *     one of theirs, and those differ over key order and whitespace.
 *  2. A redelivery must not pay twice. Providers retry on any non-2xx, and on
 *     timeouts where we did in fact succeed.
 *  3. A rejected delivery is still recorded. Repeated signature failures are
 *     how a leaked or rotated secret announces itself, and a body we threw away
 *     cannot be investigated.
 */

const SIGNATURE_HEADER = 'x-webhook-signature';
const TIMESTAMP_HEADER = 'x-webhook-timestamp';

/** Runs an express-style middleware as a promise. */
const runMiddleware = (middleware, req, res) => new Promise((resolve, reject) => {
  middleware(req, res, err => (err ? reject(err) : resolve()));
});

const PROVIDERS = {
  /**
   * Splite's own HMAC scheme.
   *
   * `verify` is the middleware that has sat complete and unmounted in
   * `src/middleware/webhookSignature.js` since phase 1 -- signature over
   * `${timestamp}.${rawBody}`, a two-sided tolerance window, and single-use
   * enforcement in Redis that fails closed.
   *
   * This was very nearly a second implementation of the same three rules,
   * written here because the first one was not mounted anywhere and so did not
   * turn up in a search of the routes. The duplicate was the weaker of the two:
   * identical signing, no replay protection. Two verifiers for one credential
   * is how one of them quietly stops being the one that runs.
   *
   * Keeping it behind the provider entry preserves the seam that matters: an
   * acquirer with its own scheme supplies its own `verify`, and nothing else
   * changes.
   */
  SPLITE: {
    verify: verifyWebhookSignature({ replayProtection: true }),

    parse(body) {
      const providerPaymentId = body?.id ?? body?.paymentId ?? null;
      // The provider's id for *this delivery*, not for the payment. One payment
      // can produce several events, so the payment id cannot stand in for it.
      const providerEventId = body?.eventId ?? body?.event_id ?? null;
      const status = String(body?.status ?? '').toUpperCase();
      return {
        providerEventId: providerEventId ? String(providerEventId) : null,
        providerPaymentId: providerPaymentId ? String(providerPaymentId) : null,
        // Our own payment id, when the provider was given one to echo back.
        paymentId: body?.metadata?.splitePaymentId ?? null,
        restaurantId: body?.metadata?.restaurantId ?? null,
        amountVes: body?.amountVes != null ? String(body.amountVes) : null,
        succeeded: status === 'SUCCEEDED' || status === 'COMPLETED' || status === 'PAID',
        failed: status === 'FAILED' || status === 'DECLINED' || status === 'CANCELLED'
      };
    }
  }
};

/** Records what arrived and what we did with it. Never throws at the caller. */
const recordDelivery = (fields) =>
  db.query(
    `INSERT INTO webhook_deliveries
       (provider, provider_event_id, provider_payment_id, payment_id, raw_body, signature, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      fields.provider,
      fields.providerEventId ?? null,
      fields.providerPaymentId ?? null,
      fields.paymentId ?? null,
      fields.rawBody ?? '',
      fields.signature ?? null,
      fields.outcome,
      fields.detail ?? null
    ]
  ).catch(err => logger.error({ event: 'WEBHOOK_DELIVERY_LOG_FAILED', err },
    'Could not record webhook delivery'));

/**
 * Has this event already reached a terminal outcome?
 *
 * A cheap read taken before opening a transaction. Retry storms are the normal
 * case, not the exception, and without this every redelivery would queue for a
 * FOR UPDATE lock on a payment row just to discover it has nothing to do. It is
 * only an optimisation: the primary key inside the transaction is what makes
 * the guarantee, and a duplicate that slips past this read still loses there.
 */
async function alreadyProcessed(provider, providerEventId) {
  if (!providerEventId) return null;
  const { rows } = await db.query(
    `SELECT payment_id, outcome FROM webhook_events_processed
      WHERE provider = $1 AND provider_event_id = $2`,
    [provider, providerEventId]
  );
  return rows[0] ?? null;
}

/**
 * Authenticates, records, and settles.
 *
 * Ordering is deliberate: authenticate first so an unauthenticated body cannot
 * fill the evidence table, then record, then act.
 */
async function handleDelivery(req, res, providerCode) {
  const provider = PROVIDERS[providerCode];
  if (!provider) {
    throw new ApiError('WEBHOOK_PROVIDER_UNKNOWN', 'No adapter for that provider', {
      provider: providerCode
    });
  }

  const signature = req.get(SIGNATURE_HEADER) ?? null;
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';

  try {
    await runMiddleware(provider.verify, req, res);
  } catch (err) {
    await recordDelivery({
      provider: providerCode, rawBody, signature,
      outcome: {
        WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE: 'TIMESTAMP_OUT_OF_TOLERANCE',
        WEBHOOK_ALREADY_PROCESSED: 'REPLAYED',
        WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE: 'REPLAY_STORE_DOWN'
      }[err.code] || 'SIGNATURE_INVALID',
      detail: err.message
    });
    logger.warn({ event: 'WEBHOOK_REJECTED', provider: providerCode, code: err.code, ip: req.ip },
      'Webhook rejected before processing');
    throw err;
  }

  const parsed = provider.parse(req.body);

  // Durable duplicate detection, unlike the Redis key the middleware sets:
  // that one is over the signature and lives ten minutes, and providers re-sign
  // each retry, so it only ever caught byte-identical replays inside the
  // tolerance window. Retry budgets are measured in days.
  const seen = await alreadyProcessed(providerCode, parsed.providerEventId);
  if (seen) {
    await recordDelivery({
      provider: providerCode, rawBody, signature,
      providerEventId: parsed.providerEventId,
      providerPaymentId: parsed.providerPaymentId,
      paymentId: seen.payment_id,
      outcome: 'DUPLICATE',
      detail: `Already processed as ${seen.outcome}`
    });
    // 2xx, emphatically. A duplicate answered with an error is how a provider
    // is taught to retry forever.
    return { received: true, settled: false, reason: 'DUPLICATE' };
  }

  if (!parsed.paymentId || !parsed.restaurantId) {
    // Nothing to attribute it to. Recorded rather than discarded: this is
    // exactly the delivery somebody will need to read.
    await recordDelivery({
      provider: providerCode, rawBody, signature,
      providerPaymentId: parsed.providerPaymentId,
      outcome: 'UNPARSEABLE',
      detail: 'Delivery does not name a Splite payment and restaurant'
    });
    return { received: true, settled: false, reason: 'UNATTRIBUTED' };
  }

  const result = await settleFromWebhook({ providerCode, parsed, rawBody, signature });
  return result;
}

async function settleFromWebhook({ providerCode, parsed, rawBody, signature }) {
  const { paymentId, restaurantId } = parsed;

  const outcome = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, bill_id, amount_ves, status
         FROM payments
        WHERE id = $1 AND restaurant_id = $2
        FOR UPDATE`,
      [paymentId, restaurantId]
    );
    const payment = rows[0];
    // Rolls back the claim above, so the retry this triggers can re-claim.
    if (!payment) throw new ApiError('WEBHOOK_PAYMENT_UNRESOLVED', 'No such payment yet');

    const result = await (async () => {
      // A redelivery of something already settled is success, not an error: the
      // provider retried because our 200 was lost, and answering non-2xx would
      // have it retry forever. A late FAILED for a bill that is already paid
      // lands here too, and must not reopen it.
      if (payment.status !== 'PENDING') {
        return { kind: 'DUPLICATE', status: payment.status };
      }

      if (parsed.failed) {
        await transitionPayment(client, {
          paymentId, restaurantId, toStatus: 'FAILED',
          reason: `Reported failed by ${providerCode}`, actorType: 'SYSTEM'
        });
        return { kind: 'FAILED' };
      }

      if (!parsed.succeeded) return { kind: 'IGNORED' };

      // The amount is taken from OUR record, not from the provider's body. A
      // signed body still only proves who sent it, and settling whatever number
      // it names would let a compromised provider key rewrite a bill.
      const applied = await applyToBill(client, {
        restaurantId, billId: payment.bill_id, amount: BigInt(payment.amount_ves)
      });

      await transitionPayment(client, {
        paymentId, restaurantId, toStatus: 'SUCCEEDED',
        reason: `Confirmed by ${providerCode}`, actorType: 'SYSTEM'
      });

      return { kind: 'SETTLED', settlement: { ...settlementView(applied.bill, applied), paymentId } };
    })();

    // Claim the event, now that it has reached a terminal outcome and now that
    // the payment it names is known to exist -- the row carries a foreign key
    // to it, so claiming first would fail on the very case this whole path
    // exists for: a callback that overtook our own commit.
    //
    // Still inside the transaction, so the claim and the settlement are
    // inseparable: no ordering leaves money moved and the event unrecorded, or
    // the reverse. And an attempt that throws rolls this back with everything
    // else, which is what keeps a failed delivery retryable -- a claim that
    // outlived its failure would block the retry meant to fix it.
    if (parsed.providerEventId) {
      await client.query(
        `INSERT INTO webhook_events_processed (provider, provider_event_id, payment_id, outcome)
         VALUES ($1, $2, $3, $4)`,
        [providerCode, parsed.providerEventId, payment.id, result.kind]
      );
    }

    return result;
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs })
    .catch(async err => {
      // Lost the race for the primary key: another delivery of this same event
      // committed while this one was working. It settled, so this is a
      // duplicate and a duplicate is a success.
      if (err.code === '23505' && String(err.constraint || '').includes('webhook_events_processed')) {
        return { kind: 'DUPLICATE', status: 'concurrent' };
      }

      // Everything else -- an unresolved payment, a deadlock, a statement
      // timeout, the database being unreachable -- must reach the provider as
      // a non-2xx so it retries. The delivery is recorded first, because the
      // one thing worse than a failed settlement is a failed settlement with
      // no trace of what arrived.
      await recordDelivery({
        provider: providerCode, rawBody, signature,
        providerEventId: parsed.providerEventId,
        providerPaymentId: parsed.providerPaymentId,
        outcome: err.code === 'WEBHOOK_PAYMENT_UNRESOLVED' ? 'PAYMENT_UNRESOLVED' : 'PROCESSING_FAILED',
        detail: err.message
      });
      logger.warn(
        { event: 'WEBHOOK_PROCESSING_FAILED', provider: providerCode, paymentId, code: err.code },
        'Webhook could not be processed; provider should retry'
      );
      throw err;
    });

  await recordDelivery({
    provider: providerCode, rawBody, signature,
    providerEventId: parsed.providerEventId,
    providerPaymentId: parsed.providerPaymentId,
    paymentId,
    outcome: outcome.kind === 'SETTLED' ? 'SETTLED' : outcome.kind,
    detail: outcome.status ? `Already ${outcome.status}` : null
  });

  if (outcome.kind === 'SETTLED') {
    await logAudit({
      restaurantId,
      action: 'PAYMENT_SETTLED_BY_WEBHOOK',
      resourceType: 'payment',
      resourceId: paymentId,
      details: { provider: providerCode, billStatus: outcome.settlement.status }
    });
    logger.info({ event: 'WEBHOOK_SETTLED', paymentId, restaurantId, provider: providerCode },
      'Payment settled from webhook');
  }

  return {
    received: true,
    settled: outcome.kind === 'SETTLED',
    reason: outcome.kind
  };
}

module.exports = { handleDelivery, PROVIDERS, SIGNATURE_HEADER, TIMESTAMP_HEADER };
