const crypto = require('crypto');
const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { safeEqual } = require('../utils/tokens');
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

const SIGNATURE_HEADER = 'x-splite-signature';
const TIMESTAMP_HEADER = 'x-splite-timestamp';

const PROVIDERS = {
  /**
   * Splite's own HMAC scheme.
   *
   * Signed value is `${timestamp}.${rawBody}`, so a captured signature cannot be
   * replayed with a different body, and the timestamp is inside the MAC rather
   * than merely alongside it -- a timestamp an attacker can edit freely buys
   * nothing.
   */
  SPLITE: {
    authenticate(req) {
      const signature = req.get(SIGNATURE_HEADER);
      const timestamp = req.get(TIMESTAMP_HEADER);
      if (!signature || !timestamp) {
        throw new ApiError('WEBHOOK_SIGNATURE_MISSING', 'Signature headers are required');
      }

      const sent = Number(timestamp);
      if (!Number.isFinite(sent)) {
        throw new ApiError('WEBHOOK_SIGNATURE_INVALID', 'Malformed timestamp');
      }
      const drift = Math.abs(Math.floor(Date.now() / 1000) - sent);
      if (drift > config.webhookToleranceSeconds) {
        throw new ApiError(
          'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE',
          'Timestamp is outside the accepted window'
        );
      }

      // rawBody, never req.body. If the parser did not capture it there is
      // nothing to verify and the only safe answer is to reject.
      if (typeof req.rawBody !== 'string') {
        throw new ApiError('WEBHOOK_BODY_UNVERIFIABLE', 'Raw body unavailable for verification');
      }

      const expected = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(`${timestamp}.${req.rawBody}`)
        .digest('hex');

      if (!safeEqual(expected, signature)) {
        throw new ApiError('WEBHOOK_SIGNATURE_INVALID', 'Signature does not match');
      }
    },

    parse(body) {
      const providerPaymentId = body?.id ?? body?.paymentId ?? null;
      const status = String(body?.status ?? '').toUpperCase();
      return {
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
       (provider, provider_payment_id, payment_id, raw_body, signature, outcome, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      fields.provider,
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
 * Authenticates, records, and settles.
 *
 * Ordering is deliberate: authenticate first so an unauthenticated body cannot
 * fill the evidence table, then record, then act.
 */
async function handleDelivery(req, providerCode) {
  const provider = PROVIDERS[providerCode];
  if (!provider) {
    throw new ApiError('WEBHOOK_PROVIDER_UNKNOWN', 'No adapter for that provider', {
      provider: providerCode
    });
  }

  const signature = req.get(SIGNATURE_HEADER) ?? null;
  const rawBody = typeof req.rawBody === 'string' ? req.rawBody : '';

  try {
    provider.authenticate(req);
  } catch (err) {
    await recordDelivery({
      provider: providerCode, rawBody, signature,
      outcome: err.code === 'WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE'
        ? 'TIMESTAMP_OUT_OF_TOLERANCE' : 'SIGNATURE_INVALID',
      detail: err.message
    });
    logger.warn({ event: 'WEBHOOK_REJECTED', provider: providerCode, code: err.code, ip: req.ip },
      'Webhook rejected before processing');
    throw err;
  }

  const parsed = provider.parse(req.body);

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
    if (!payment) return { kind: 'PAYMENT_NOT_FOUND' };

    // A redelivery of something already settled is success, not an error: the
    // provider retried because our 200 was lost, and answering non-2xx would
    // have it retry forever.
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
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

  await recordDelivery({
    provider: providerCode, rawBody, signature,
    providerPaymentId: parsed.providerPaymentId,
    paymentId: outcome.kind === 'PAYMENT_NOT_FOUND' ? null : paymentId,
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
