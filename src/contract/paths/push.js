'use strict';

const { commonErrors, staff } = require('../common');

/**
 * Avisos en el teléfono del personal (R19).
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const subscriptionBody = {
  type: 'object',
  required: ['endpoint', 'keys'],
  properties: {
    endpoint: {
      type: 'string', format: 'uri', maxLength: 2048,
      description: 'The browser push service address. Only the known services are accepted (FCM, Mozilla, Apple, Windows).'
    },
    expirationTime: { description: 'Ignored.' },
    keys: {
      type: 'object',
      required: ['p256dh', 'auth'],
      properties: {
        p256dh: { type: 'string', description: 'base64url P-256 public key' },
        auth: { type: 'string', description: 'base64url auth secret' }
      }
    }
  },
  additionalProperties: false
};

const core = {

  '/api/v1/push/config': {
    get: {
      tags: ['Push'],
      summary: 'Whether push is on, and the key to subscribe with',
      operationId: 'getPushConfig',
      description: [
        'Any staff role. `publicKey` is the VAPID application server key for',
        '`PushManager.subscribe({ applicationServerKey })`. It never changes for a deployment:',
        'changing it would invalidate every subscription.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Push configuration.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['enabled', 'publicKey'],
                properties: {
                  enabled: { type: 'boolean' },
                  publicKey: { type: ['string', 'null'], description: 'base64url; null when push is off' }
                }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/push/subscriptions': {
    post: {
      tags: ['Push'],
      summary: 'Send notifications to this phone',
      operationId: 'createPushSubscription',
      description: [
        'The body is `PushSubscription.toJSON()`. One row per browser: if somebody else signs in on',
        'the same phone, the subscription becomes theirs.',
        '',
        'What arrives depends on the role: payment notices to verify go to OWNER, MANAGER and CASHIER;',
        'orders from the table (and first orders awaiting approval) go to OWNER, MANAGER and WAITER.',
        'Nothing personal is ever in a notification: table, amount and what was ordered.',
        '',
        'Every subscription of a user is dropped when all their sessions are revoked (deactivated,',
        'role changed, password reset).'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: subscriptionBody } } },
      responses: {
        204: { description: 'Subscribed.' },
        ...commonErrors
      }
    },
    delete: {
      tags: ['Push'],
      summary: 'Stop notifications on this phone',
      operationId: 'deletePushSubscription',
      description: 'Only the caller\'s own subscription. No error if it was already gone.',
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object', required: ['endpoint'], additionalProperties: false,
              properties: { endpoint: { type: 'string', format: 'uri', maxLength: 2048 } }
            }
          }
        }
      },
      responses: {
        204: { description: 'Unsubscribed.' },
        ...commonErrors
      }
    }
  },

  '/api/v1/push/test': {
    post: {
      tags: ['Push'],
      summary: 'Send a test notification to my phones',
      operationId: 'sendPushTest',
      description: '`PUSH_NOT_SUBSCRIBED` when the caller has no subscription; `PUSH_DISABLED` when push is off.',
      security: staff,
      responses: {
        200: {
          description: 'How many of the caller\'s devices it reached.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['sent', 'devices'],
                properties: { sent: { type: 'integer' }, devices: { type: 'integer' } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  }
};

module.exports = { core };
