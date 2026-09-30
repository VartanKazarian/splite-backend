'use strict';

const { ref, response } = require('../common');

/**
 * Webhooks firmados de proveedores de pago.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {

  '/api/v1/webhooks/{provider}': {
    post: {
      tags: ['Webhooks'],
      summary: 'Inbound payment notification from a provider',
      operationId: 'receiveWebhook',
      description: [
        'No session: a provider has no login. The **HMAC signature is the credential**, and it is',
        'verified before the body is read, recorded or acted on.',
        '',
        'Headers: `X-Webhook-Signature` (hex HMAC-SHA256) and `X-Webhook-Timestamp` (unix seconds).',
        'The signed value is `{timestamp}.{rawBody}`, so a captured signature cannot be replayed',
        'against a different body, and the timestamp is inside the MAC rather than merely beside it.',
        'The tolerance window is two-sided: a far-future timestamp is as invalid as a stale one.',
        '',
        'A signature may be used **once**. Single-use is enforced in Redis and fails closed — if the',
        'replay store is unreachable this answers 503 `WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE`',
        'rather than risk handling a money-moving callback twice.',
        '',
        'The **amount is taken from our own record, never from the body.** A valid signature proves',
        'who sent the delivery and nothing more; settling whatever figure it names would let a',
        'compromised provider key rewrite a bill.',
        '',
        '**202 means stop sending this.** Settled, a duplicate of something settled, or a body that',
        'never named a payment and never will however many times it is resent. Providers retry on',
        'any non-2xx and on timeouts where we in fact succeeded, so answering a duplicate with an',
        'error teaches one to retry forever. Read `settled` and `reason` for what happened.',
        '',
        '**It does not cover a delivery we merely failed to process.** A callback can overtake the',
        'commit of our own PENDING row, and answering 202 to that loses a real settlement',
        'permanently — the money has moved and the bill never closes. Those answer 503',
        '`WEBHOOK_PAYMENT_UNRESOLVED` with `Retry-After`, as do database failures.',
        '',
        'Send an `eventId`. Duplicate detection is a primary key on `(provider, eventId)` written',
        'inside the settling transaction, which is durable and event-scoped; the signature-keyed',
        'Redis entry is a ten-minute optimisation that a re-signed retry does not match. Without an',
        '`eventId` the only protection left is the payment status check, which cannot tell two',
        'events for one payment apart. A failed attempt claims nothing, so the retry can succeed.',
        '',
        'Only the `SPLITE` provider exists today; a real acquirer is an entry in the adapter table.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'provider', in: 'path', required: true, schema: { type: 'string' }, example: 'SPLITE' }
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: {
        202: { description: 'Delivery accepted. Check `settled`.', content: { 'application/json': { schema: ref('WebhookAck') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },
};

module.exports = { core };
