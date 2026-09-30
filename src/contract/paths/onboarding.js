'use strict';

const { ref, response } = require('../common');

/**
 * Rutas del alta de restaurantes. Se sirven sólo con ONBOARDING_ENABLED.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const onboardingPaths = {
  '/api/v1/onboarding/restaurants': {
    post: {
      tags: ['Onboarding'],
      summary: 'Submit a restaurant for review',
      operationId: 'submitLead',
      'x-feature-flag': 'ONBOARDING_ENABLED',
      description: [
        'Public. Creates **no tenant and no account.** It records the submission and emails the',
        'Splite onboarding team, who read it and telephone the restaurant. The applicant gets an',
        'acknowledgement saying exactly that.',
        '',
        'Access is granted later, by a person: after the call, the team runs',
        '`npm run onboarding -- invite <id>`, which mails the single-use link that',
        '`POST /api/v1/onboarding/verify` consumes. There is no HTTP route for that step —',
        'every authenticated surface here is scoped to a tenant the caller belongs to, and there',
        'is no platform-operator role to authorise it.',
        '',
        'Returns the same 202 to everyone, including when the address or RIF already belongs to a',
        'live account. Anything else would make this an account-enumeration oracle, which is what',
        '`/auth/login` pays for a decoy Argon2 hash to avoid. The duplicate is reported to the',
        'reviewer instead, which is where a human should be looking at it anyway.',
        '',
        'Rate limited to 5/hour per source address **and** 3/hour per recipient, both fail-closed.',
        'The per-recipient limit is the one that matters: this endpoint sends mail to an address the',
        'caller chooses, so a distributed caller stays under any per-IP budget while filling one',
        "person's inbox."
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SignupRequest') } } },
      responses: {
        202: {
          description: 'Received. The onboarding team has been notified; no account exists yet.',
          content: { 'application/json': { schema: ref('SignupAccepted') } }
        },
        400: response('BadRequest'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/onboarding/verify': {
    post: {
      tags: ['Onboarding'],
      summary: 'Consume the link, create the restaurant, sign the owner in',
      operationId: 'verifySignup',
      'x-feature-flag': 'ONBOARDING_ENABLED',
      description: [
        'Public, but requires a token that the Splite team sent by email after approving the',
        'submission. Nothing mints that token except `npm run onboarding -- invite <id>`.',
        '',
        'Creates the restaurant, its OWNER user and the menu defaults (IVA 1600 bps, servicio',
        '1000 bps) in **one transaction**, then issues a session — the address is proven and the',
        'password was chosen in this same request, so a login screen here would only ask for what',
        'was just typed.',
        '',
        'A human having approved the lead is *not* why this step exists: being vouched for is not',
        'the same as controlling the inbox, and staff email is globally unique. The tenant is still',
        'born only inside the transaction that spends the token.',
        '',
        'The link is single-use and expiring. `ONBOARDING_TOKEN_INVALID` covers absent, spent and',
        'expired alike: a caller has no legitimate use for the difference, and separating them would',
        'reveal which links exist.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('VerifyRequest') } } },
      responses: {
        201: {
          description: 'Restaurant created and signed in.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  ref('Session'),
                  { type: 'object', properties: { restaurant: ref('Account') } }
                ]
              }
            }
          }
        },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  }
};

module.exports = { onboardingPaths };
