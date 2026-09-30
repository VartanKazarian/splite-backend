'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Avisos de pago, cobros C2P, propinas y conciliación.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const tips = {

  '/api/v1/payments/tips/mine': {
    get: {
      tags: ['Payments'],
      summary: 'Your own tips',
      operationId: 'getMyTips',
      description: [
        'Any authenticated staff role, **for themselves only** — there is no user id in the path.',
        '',
        'A waiter seeing their own total is the entire incentive for building tipping into the',
        'product; seeing everybody else\'s is a different feature with a different conversation',
        'behind it. A manager already has `byServer` on the shift report.',
        '',
        'Attributed through `bills.servedBy` at query time, so a manager correcting who served a',
        'table moves these figures with it.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }
      ],
      responses: {
        200: {
          description: 'Tips earned in the window.',
          content: { 'application/json': { schema: ref('MyTips') } }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/dashboard': {
    get: {
      tags: ['Payments'],
      summary: 'The whole floor in one call',
      operationId: 'getServiceSnapshot',
      description: [
        'Any authenticated staff role — a waiter needs to know which tables still owe money as much',
        'as an owner does.',
        '',
        '**The totals are summed in Postgres, not by the client.** Amounts cross the wire as strings',
        'because a browser\'s `Number` loses precision past 2^53, so a total a client assembled by',
        'adding them up is the one figure nobody checked.',
        '',
        '`from` bounds only the *since* figures — takings, tips, payment count. The floor and the',
        'queues are always **now**: an open bill is open whatever window somebody asked about.',
        '',
        'Unset, `from` means the start of the current day **in America/Caracas**, not UTC. There is',
        'no timezone on a restaurant and this product is Venezuela-only; in UTC a service ending at',
        '23:00 local lands in tomorrow, which would make the takings wrong for the last four hours of',
        'every evening. A service that crosses midnight should send `from` explicitly.',
        '',
        '**A declared Pago Móvil is not takings.** It appears under `claims.pending` and leaves',
        '`openBills.outstandingVes` untouched, because a diner saying they paid is not money until a',
        'member of staff has found it in the bank app.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } }
      ],
      responses: {
        200: {
          description: 'The room, the queues and the takings.',
          content: { 'application/json': { schema: ref('ServiceSnapshot') } }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/activity': {
    get: {
      tags: ['Payments'],
      summary: 'What has happened since the client last looked',
      operationId: 'getPaymentActivity',
      description: [
        'Any authenticated staff role. `data` is always oldest first, so it can be rendered in the',
        'order the things happened.',
        '',
        'A first call, with no `since`, returns the **latest** `limit` events rather than the oldest:',
        'a screen that has just opened wants what just happened. With `since`, the window is',
        'everything after it.',
        '',
        'Poll with the `asOf` from the previous response as `since` — never an entry\'s `at`. Those',
        'carry milliseconds while the stored timestamps carry microseconds, so an `at` used as a',
        'cursor sits just before the event it names, and that event is returned again on every poll.',
        '',
        'Two kinds, because they call for different reactions:',
        '',
        '- `SETTLED` — money became real. Table 6 has paid.',
        '- `DECLARED` — a diner *says* they paid. Somebody has to open the bank app.',
        '',
        '**This is deliberately not a push.** A real notification needs a service worker, a',
        'subscription store and a sender, none of which are built; a cursor is what makes polling',
        'cheap enough that the absence does not matter for a screen somebody is watching.',
        '',
        'Use `asOf` rather than a time the client made up — a clock running fast would otherwise skip',
        'events, and a skipped settlement is a table nobody knows has paid.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }
      ],
      responses: {
        200: {
          description: 'Events since the cursor, oldest first.',
          content: { 'application/json': { schema: ref('PaymentActivity') } }
        },
        ...commonErrors
      }
    }
  },
};

const claims = {

  '/api/v1/payments/claims/summary': {
    get: {
      tags: ['Payments'],
      summary: 'How many declared payments are waiting, and for how long',
      operationId: 'getPaymentClaimsSummary',
      description: [
        'Any authenticated staff role — including WAITER, unlike confirming. A waiter cannot decide',
        'that money arrived, but they are the person standing in the room and should be able to see',
        'that somebody is waiting on the till.',
        '',
        'This exists because nothing else tells staff a claim arrived. A diner declares a Pago Móvil,',
        'nothing moves until a person finds it in the bank app, and if nobody opens the queue the',
        'diner leaves believing they have paid. Separate from `GET /claims` so a badge on every screen',
        'is not pulling full claim rows, payer phone numbers included, to render a number.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The queue, as two numbers.', content: { 'application/json': { schema: ref('ClaimsSummary') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/claims': {
    get: {
      tags: ['Payments'],
      summary: 'Declared payments awaiting verification',
      operationId: 'listPaymentClaims',
      description: 'Any authenticated staff role. Defaults to PENDING, which is the queue somebody has to work.',
      security: staff,
      parameters: [
        { name: 'billId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        {
          name: 'status', in: 'query',
          schema: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'], default: 'PENDING' }
        },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }
      ],
      responses: {
        200: {
          description: 'Claims, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('StaffPaymentClaim') } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/claims/{id}/confirm': {
    post: {
      tags: ['Payments'],
      summary: 'Confirm the money arrived, and settle the bill',
      operationId: 'confirmPaymentClaim',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER. A waiter can take an order; deciding that money arrived',
        'is a cashier\'s job upwards.',
        '',
        'This is the moment the bill moves. It goes through the same settlement path as a staff',
        'split and a provider webhook, so a confirmed claim cannot overpay a bill or close one that',
        'was voided while it sat in the queue — 409 `PAYMENT_EXCEEDS_BALANCE` and `BILL_NOT_OPEN`',
        'are both reachable here and both mean the claim should be rejected instead.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Settled.', content: { 'application/json': { schema: ref('PaymentResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/payments/claims/{id}/reject': {
    post: {
      tags: ['Payments'],
      summary: 'Record that the money could not be found',
      operationId: 'rejectPaymentClaim',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER.',
        '',
        'FAILED rather than deleted: if a diner insists they paid, the record of what they declared',
        'and who rejected it is the only way to settle the argument. Rejecting also releases the',
        'reference, so a diner who simply mistyped can declare again.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { reason: { type: 'string', maxLength: 500, description: '"No aparece" and "el monto no coincide" are different problems.' } }
            }
          }
        }
      },
      responses: {
        200: { description: 'Rejected.', content: { 'application/json': { schema: ref('StaffPaymentClaim') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },
};

const tips2 = {

  '/api/v1/payments/tips': {
    get: {
      tags: ['Payments'],
      summary: 'Tips taken over a period',
      operationId: 'getTipsReport',
      description: [
        'Any authenticated staff role — this is the figure a shift is divided by, and whoever hands',
        'the money out has to be able to read it.',
        '',
        '`from` is inclusive and `to` exclusive, so consecutive shifts tile without counting the',
        'boundary twice. Both are required: a report whose period was guessed is a number somebody',
        'hands out money against.',
        '',
        '**The window is on settlement time**, not on when the payment row was created. Those differ',
        'for a declared Pago Móvil, which is created when the diner says they paid and settles when',
        'staff verify it. Windowing on settlement is what makes a past shift final: once its queue is',
        'worked, its number never changes again.',
        '',
        '**Only SUCCEEDED payments count.** A tip on an unverified Pago Móvil claim is money a diner',
        '*says* they sent, and paying staff against it is the mistake the confirmation step exists to',
        'prevent. IN_DOUBT and AMBIGUOUS C2P charges are excluded for the same reason.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }
      ],
      responses: {
        200: { description: 'Tips over the period.', content: { 'application/json': { schema: ref('TipsReport') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/c2p/unresolved': {
    get: {
      tags: ['Payments'],
      summary: 'C2P charges that reached no settled state',
      operationId: 'listUnresolvedC2PCharges',
      description: [
        'Any authenticated staff role.',
        '',
        '`IN_DOUBT` means the bank never told us what happened. `AMBIGUOUS` means it has money',
        'matching the amount that nothing ties to this diner, or it confirmed a debit that could not',
        'be credited to the bill.',
        '',
        'This queue is what makes refusing to guess usable. A charge nobody is looking at is',
        'indistinguishable from one that was lost.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/Limit' }],
      responses: {
        200: {
          description: 'Unresolved charges, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('C2PUnresolvedCharge') } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/c2p/{id}/resolve': {
    post: {
      tags: ['Payments'],
      summary: 'Ask Mercantil what happened to an in-doubt charge',
      operationId: 'resolveC2PCharge',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER. This can settle a bill, so it is a cashier\'s job upwards.',
        '',
        'Settles only when a bank movement matches on **both** the amount and the last four digits',
        'of the payer\'s phone. Amount alone is a filter, never a decision: two tables owing the same',
        'total is the ordinary case in a restaurant, and matching on amount would settle one table',
        'with the other\'s money.',
        '',
        'A movement it cannot attribute moves the charge to `AMBIGUOUS` with the candidate',
        'references attached. Re-running an `AMBIGUOUS` charge returns it unchanged — the system has',
        'already said it cannot tell them apart, and asking again will not change that.',
        '',
        'Inside the settlement window a missing movement returns `resolutionPending` rather than',
        'failing the charge: interbank settlement is not instant, and failing a debit still in',
        'flight is the same double-charge error in slower motion.',
        '',
        '409 `PAYMENT_REFERENCE_ALREADY_USED` means the movement it matched had already settled a',
        'different payment. The charge stays unresolved.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'What asking the bank produced.', content: { 'application/json': { schema: ref('C2PResolution') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        503: response('ServiceUnavailable')
      }
    }
  },
};

module.exports = { tips, claims, tips2 };
