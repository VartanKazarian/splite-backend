'use strict';

const { ref, response, minorUnits, commonErrors, operator } = require('../common');

/**
 * La consola de Splite para el equipo (operadores).
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const auth = {

  '/api/v1/admin/auth/login': {
    post: {
      tags: ['Operator console'],
      summary: 'Sign in to the Splite console',
      operationId: 'operatorLogin',
      description: 'Email, password and the authenticator code in one request. Every failure is the same `INVALID_CREDENTIALS`, and a code works once. Rate-limited like the staff login.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email', 'password', 'code'], properties: { email: { type: 'string', format: 'email' }, password: { type: 'string' }, code: { type: 'string', pattern: '^[0-9]{6}$' } } } } } },
      responses: {
        200: { description: 'Signed in.', content: { 'application/json': { schema: ref('OperatorSession') } } },
        400: response('BadRequest'), 401: response('Unauthorized'), 429: response('TooManyRequests'), 500: response('ServerError')
      }
    }
  },

  '/api/v1/admin/auth/bootstrap': {
    post: {
      tags: ['Operator console'],
      summary: 'Create the first operator from the browser',
      operationId: 'operatorBootstrap',
      description: [
        'Only while no operator exists, and only with the phrase set in `OPERATOR_BOOTSTRAP_TOKEN` (24+ characters).',
        'Creates an ADMIN and returns a setup token for `/auth/setup/start` — the second factor is still mandatory.',
        'Once one operator exists this is gone for good, even if the variable stays set; later operators come from',
        '`npm run operator`. Every refusal is the same 404, so it reveals neither whether the phrase is set nor whether',
        'operators exist. Rate-limited like the login.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'email', 'displayName'], properties: { token: { type: 'string' }, email: { type: 'string', format: 'email' }, displayName: { type: 'string', maxLength: 80 } } } } } },
      responses: {
        201: { description: 'Created; continue with the setup token.', content: { 'application/json': { schema: { type: 'object', properties: { setupToken: { type: 'string' } } } } } },
        400: response('BadRequest'), 404: response('NotFound'), 429: response('TooManyRequests'), 500: response('ServerError')
      }
    }
  },

  '/api/v1/admin/auth/setup/start': {
    post: {
      tags: ['Operator console'],
      summary: 'Open a setup link',
      operationId: 'operatorSetupStart',
      description: 'The link comes from `npm run operator -- create|reset`. Returns what the authenticator needs. Repeatable until the setup is completed; an expired, used or unknown token is a 404.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } } } } },
      responses: {
        200: { description: 'Authenticator details.', content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, displayName: { type: 'string' }, secret: { type: 'string' }, otpauthUri: { type: 'string' } } } } } },
        400: response('BadRequest'), 404: response('NotFound'), 429: response('TooManyRequests'), 500: response('ServerError')
      }
    }
  },

  '/api/v1/admin/auth/setup/complete': {
    post: {
      tags: ['Operator console'],
      summary: 'Finish setup: password and a first code',
      operationId: 'operatorSetupComplete',
      description: 'The password needs 14 characters or more. The code proves the authenticator is linked; the second factor is mandatory for every operator. Signs the operator in.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['token', 'password', 'code'], properties: { token: { type: 'string' }, password: { type: 'string', minLength: 14 }, code: { type: 'string', pattern: '^[0-9]{6}$' } } } } } },
      responses: {
        200: { description: 'Signed in.', content: { 'application/json': { schema: ref('OperatorSession') } } },
        400: response('BadRequest'), 401: response('Unauthorized'), 404: response('NotFound'), 429: response('TooManyRequests'), 500: response('ServerError')
      }
    }
  },

  '/api/v1/admin/me': {
    get: {
      tags: ['Operator console'], summary: 'Who is signed in', operationId: 'operatorMe',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      responses: {
        200: { description: 'The operator.', content: { 'application/json': { schema: { type: 'object', properties: { operator: ref('Operator') } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/clients': {
    get: {
      tags: ['Operator console'], summary: 'Every restaurant, with plan, price, balance and activity', operationId: 'adminListClients',
      description: 'ADMIN and SUPPORT. `summary` counts restaurants per state and adds up monthly recurring revenue (ACTIVE and OVERDUE, annual prices divided by twelve) and what is outstanding.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      parameters: [
        { name: 'q', in: 'query', schema: { type: 'string', maxLength: 80 }, description: 'Name, RIF or any staff email.' },
        { name: 'state', in: 'query', schema: { type: 'string', enum: ['TRIAL', 'TRIAL_EXPIRED', 'ACTIVE', 'OVERDUE', 'SUSPENDED', 'CANCELLED'] } }
      ],
      responses: {
        200: { description: 'Clients.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('AdminClient') }, summary: { type: 'object', properties: { total: { type: 'integer' }, byState: { type: 'object' }, monthlyRecurringUsd: minorUnits, outstandingUsd: minorUnits } } } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/clients/{restaurantId}': {
    get: {
      tags: ['Operator console'], summary: 'One client: billing, usage, setup and history', operationId: 'adminGetClient',
      description: 'ADMIN and SUPPORT. `usage` is the last 30 days; `history` is the console\'s own trail for this restaurant, newest first.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      parameters: [{ name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'The client.', content: { 'application/json': { schema: { type: 'object', properties: {
          client: ref('AdminClient'),
          charges: { type: 'array', items: ref('AdminCharge') },
          payments: { type: 'array', items: ref('AdminPayment') },
          usage: { type: 'object', properties: { bills30d: { type: 'integer' }, collectedVes30d: minorUnits, tables: { type: 'integer' }, staff: { type: 'integer' }, products: { type: 'integer' }, bankConnections: { type: 'integer' } } },
          setup: { type: 'object', properties: { menuLoaded: { type: 'boolean' }, tablesCreated: { type: 'boolean' }, rifSet: { type: 'boolean' }, bankConnected: { type: 'boolean' } } },
          history: { type: 'array', items: { type: 'object', properties: { action: { type: 'string' }, details: { type: ['object', 'null'] }, operatorEmail: { type: ['string', 'null'] }, at: { type: 'string', format: 'date-time' } } } }
        } } } } },
        403: response('Forbidden'), 404: response('NotFound'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/clients/{restaurantId}/plan': {
    patch: {
      tags: ['Operator console'], summary: 'Change the plan', operationId: 'adminChangePlan',
      description: 'ADMIN only. The same rule as `npm run plan -- set`: a downgrade that removes something the restaurant already uses (fiscal invoicing) needs `force`. Leaving TRIAL clears the trial date.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tier'], properties: { tier: { type: 'string', enum: ['TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'] }, trialDays: { type: ['integer', 'null'], minimum: 1, maximum: 365 }, force: { type: 'boolean' }, note: { type: ['string', 'null'] } } } } } },
      responses: {
        200: { description: 'Changed.', content: { 'application/json': { schema: { type: 'object', properties: { tier: { type: 'string' }, trialEndsAt: { type: ['string', 'null'], format: 'date-time' }, gained: { type: 'array', items: { type: 'string' } }, lost: { type: 'array', items: { type: 'string' } } } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/clients/{restaurantId}/subscription': {
    patch: {
      tags: ['Operator console'], summary: 'Billing cycle, agreed price, status and notes', operationId: 'adminUpdateSubscription',
      description: 'ADMIN only. `customPriceUsd: null` goes back to the list price. SUSPENDED and CANCELLED are recorded for billing; they do not yet switch anything off in the product.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { billingCycle: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] }, customPriceUsd: { ...minorUnits, type: ['string', 'null'] }, status: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'CANCELLED'] }, notes: { type: ['string', 'null'] }, reason: { type: ['string', 'null'] } } } } } },
      responses: {
        200: { description: 'The client, updated (same shape as GET).', content: { 'application/json': { schema: { type: 'object', properties: { client: ref('AdminClient') } } } } },
        403: response('Forbidden'), 404: response('NotFound'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/clients/{restaurantId}/charges': {
    post: {
      tags: ['Operator console'], summary: 'Charge the next period', operationId: 'adminCreateCharge',
      description: 'ADMIN only. Without `periodStart`, the period starts where the last live charge ended, or today. The amount is the agreed price, else the list price for the plan and cycle on that date; a trial has none, so it cannot be charged by accident. Due five days after the period starts.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { periodStart: { type: ['string', 'null'], format: 'date' } } } } } },
      responses: {
        201: { description: 'Created.', content: { 'application/json': { schema: { type: 'object', properties: { charge: ref('AdminCharge') } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/clients/{restaurantId}/payments': {
    post: {
      tags: ['Operator console'], summary: 'Record a payment received', operationId: 'adminRecordPayment',
      description: 'ADMIN only. A VES payment needs a rate; without `fxRate` today\'s BCV rate is used, and if there is none the request is refused rather than guessed. What it takes off the charge is fixed at that rate. When a charge is covered it becomes PAID; `settle` closes it despite a small shortfall, and says so in the trail.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['method', 'currency', 'amount', 'receivedOn'], properties: {
        chargeId: { type: ['string', 'null'], format: 'uuid' },
        method: { type: 'string', enum: ['PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER'] },
        currency: { type: 'string', enum: ['VES', 'USD'] },
        amount: minorUnits,
        fxRate: { type: ['string', 'null'], pattern: '^\\d{1,12}(\\.\\d{1,8})?$' },
        reference: { type: ['string', 'null'] },
        receivedOn: { type: 'string', format: 'date' },
        notes: { type: ['string', 'null'] },
        settle: { type: 'boolean' }
      } } } } },
      responses: {
        201: { description: 'Recorded.', content: { 'application/json': { schema: { type: 'object', properties: { payment: ref('AdminPayment'), charge: { oneOf: [ref('AdminCharge'), { type: 'null' }] } } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/charges': {
    get: {
      tags: ['Operator console'], summary: 'Charges across every client', operationId: 'adminListCharges',
      description: 'ADMIN and SUPPORT. `OVERDUE` is a filter (open and past due), not a stored status. Up to 500, latest due date first.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['OPEN', 'OVERDUE', 'PAID', 'VOID'] } }],
      responses: {
        200: { description: 'Charges.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('AdminCharge') } } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/charges/{chargeId}/void': {
    post: {
      tags: ['Operator console'], summary: 'Void a charge made by mistake', operationId: 'adminVoidCharge',
      description: 'ADMIN only, with a reason. Only an open charge with no payments applied; its period can then be charged again.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'chargeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } } } } } },
      responses: {
        200: { description: 'Voided.', content: { 'application/json': { schema: { type: 'object', properties: { charge: ref('AdminCharge') } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/prices': {
    get: {
      tags: ['Operator console'], summary: 'The price list', operationId: 'adminListPrices',
      description: 'ADMIN and SUPPORT. `current` is what applies today per plan and cycle; `history` is every price ever set.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      responses: {
        200: { description: 'Prices.', content: { 'application/json': { schema: { type: 'object', properties: { current: { type: 'array', items: ref('PlanPrice') }, history: { type: 'array', items: ref('PlanPrice') } } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    },
    post: {
      tags: ['Operator console'], summary: 'Set a price from a date', operationId: 'adminSetPrice',
      description: 'ADMIN only. A new price is a new row from `effectiveFrom` (default today): charges already made keep their amount. The same plan, cycle and date replaces that day\'s price.',
      security: operator, 'x-required-roles': ['ADMIN'],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['tier', 'billingCycle', 'amountUsd'], properties: { tier: { type: 'string', enum: ['STARTER', 'PRO', 'ENTERPRISE'] }, billingCycle: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] }, amountUsd: minorUnits, effectiveFrom: { type: ['string', 'null'], format: 'date' } } } } } },
      responses: {
        201: { description: 'Set.', content: { 'application/json': { schema: { type: 'object', properties: { price: ref('PlanPrice') } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },
};

const notices = {

  '/api/v1/admin/notices': {
    get: {
      tags: ['Operator console'], summary: 'Payment notices from restaurants', operationId: 'adminListNotices',
      description: 'ADMIN and SUPPORT. PENDING by default.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'REJECTED'] } }],
      responses: {
        200: { description: 'Notices.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('SubscriptionNotice') } } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/notices/{noticeId}/confirm': {
    post: {
      tags: ['Operator console'], summary: 'The money arrived: record it', operationId: 'adminConfirmNotice',
      description: 'ADMIN only. Records the payment from the notice (VES at `fxRate`, or today\'s BCV rate) and marks the notice confirmed, in one transaction. If the charge was closed meanwhile, the payment is recorded on account.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'noticeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { fxRate: { type: ['string', 'null'] }, settle: { type: 'boolean' } } } } } },
      responses: {
        200: { description: 'Recorded.', content: { 'application/json': { schema: { type: 'object', properties: { payment: ref('AdminPayment'), charge: { oneOf: [ref('AdminCharge'), { type: 'null' }] } } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/notices/{noticeId}/reject': {
    post: {
      tags: ['Operator console'], summary: 'Not in the bank: reject with a reason', operationId: 'adminRejectNotice',
      description: 'ADMIN only. The restaurant sees the reason.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'noticeId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 3, maxLength: 500 } } } } } },
      responses: {
        200: { description: 'Rejected.', content: { 'application/json': { schema: { type: 'object', properties: { notice: ref('SubscriptionNotice') } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/settings/payment-details': {
    get: {
      tags: ['Operator console'], summary: 'Where restaurants pay Splite', operationId: 'adminGetPaymentDetails',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      responses: {
        200: { description: 'Details.', content: { 'application/json': { schema: { type: 'object', properties: { paymentDetails: ref('PaymentDetails') } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    },
    put: {
      tags: ['Operator console'], summary: 'Set where restaurants pay Splite', operationId: 'adminSetPaymentDetails',
      description: 'ADMIN only. Shown in every restaurant\'s panel and in the reminders. Replaces the whole set.',
      security: operator, 'x-required-roles': ['ADMIN'],
      requestBody: { required: true, content: { 'application/json': { schema: ref('PaymentDetails') } } },
      responses: {
        200: { description: 'Saved.', content: { 'application/json': { schema: { type: 'object', properties: { paymentDetails: ref('PaymentDetails') } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/metrics': {
    get: {
      tags: ['Operator console'], summary: 'How the business is doing', operationId: 'adminMetrics',
      description: 'ADMIN and SUPPORT. Recurring revenue, outstanding, clients per state, trial-to-paid conversion over 180 days, cancellations in the last 30, and six months of new clients, charged and collected (US dollar cents). `rateBps` is basis points: 2500 = 25 %.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      responses: {
        200: { description: 'Metrics.', content: { 'application/json': { schema: { type: 'object', properties: {
          monthlyRecurringUsd: minorUnits, outstandingUsd: minorUnits, byState: { type: 'object' }, totalClients: { type: 'integer' },
          pendingNotices: { type: 'integer' },
          trialConversion: { type: 'object', properties: { windowDays: { type: 'integer' }, started: { type: 'integer' }, paying: { type: 'integer' }, rateBps: { type: ['integer', 'null'] } } },
          cancelledLast30Days: { type: 'integer' },
          months: { type: 'array', items: { type: 'object', properties: { month: { type: 'string' }, newClients: { type: 'integer' }, chargedUsd: minorUnits, collectedUsd: minorUnits } } }
        } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/leads': {
    get: {
      tags: ['Operator console'], summary: 'Requests from "Quiero Splite"', operationId: 'adminListLeads',
      description: 'ADMIN and SUPPORT. Newest first, up to 200.',
      security: operator, 'x-required-roles': ['ADMIN', 'SUPPORT'],
      parameters: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['NEW', 'CONTACTED', 'INVITED', 'ONBOARDED', 'REJECTED'] } }],
      responses: {
        200: { description: 'Leads.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('Lead') } } } } } },
        403: response('Forbidden'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/leads/{leadId}/status': {
    post: {
      tags: ['Operator console'], summary: 'Mark a request contacted or rejected', operationId: 'adminMarkLead',
      description: 'ADMIN only. The same as `npm run onboarding -- contacted|reject`, with the operator in the trail.',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'leadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['CONTACTED', 'REJECTED'] }, notes: { type: ['string', 'null'] } } } } } },
      responses: {
        200: { description: 'Marked.', content: { 'application/json': { schema: { type: 'object', properties: { lead: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string' } } } } } } } },
        403: response('Forbidden'), 404: response('NotFound'), ...commonErrors
      }
    }
  },

  '/api/v1/admin/leads/{leadId}/invite': {
    post: {
      tags: ['Operator console'], summary: 'Email the single-use signup link', operationId: 'adminInviteLead',
      description: 'ADMIN only. The same as `npm run onboarding -- invite`. Needs ONBOARDING_ENABLED, or the link would lead to a page that does not exist (409 ONBOARDING_DISABLED).',
      security: operator, 'x-required-roles': ['ADMIN'],
      parameters: [{ name: 'leadId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Invited.', content: { 'application/json': { schema: { type: 'object', properties: { lead: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, email: { type: 'string' }, restaurantName: { type: 'string' } } } } } } } },
        403: response('Forbidden'), 404: response('NotFound'), 409: response('Conflict'), ...commonErrors
      }
    }
  },
};

module.exports = { auth, notices };
