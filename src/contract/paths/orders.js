'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Pedidos desde la mesa.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {

  '/api/v1/orders': {
    get: {
      tags: ['Orders'],
      summary: 'Orders diners sent that the floor has not seen',
      operationId: 'listGuestOrders',
      description: [
        'Any authenticated staff role, including WAITER — a waiter is exactly who needs this.',
        '',
        'A guest order writes its lines straight onto the bill; nothing here approves anything. This is',
        'the tray of "table 4 just ordered" notices, with what was ordered, so somebody can walk over or',
        'send it to the kitchen without opening the table to find out what it was.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Unseen orders, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('GuestOrder') } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/orders/summary': {
    get: {
      tags: ['Orders'],
      summary: 'How many orders are waiting to be seen',
      operationId: 'getGuestOrdersSummary',
      description:
        'The badge figure. Separate from the list for the same reason as the claims summary: a number on every screen should not be pulling whole orders to render itself.',
      security: staff,
      responses: {
        200: { description: 'The queue, as numbers.', content: { 'application/json': { schema: ref('GuestOrdersSummary') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/orders/{id}/ack': {
    post: {
      tags: ['Orders'],
      summary: 'Mark an order as seen',
      operationId: 'acknowledgeGuestOrder',
      description: [
        'Changes nothing about the bill — the lines went on it when the diner pressed send. This only',
        'takes the notice out of the tray and records who took it.',
        '',
        'Idempotent: two waiters tapping the same notice is ordinary, and the second one is not an error.',
        'Both get 200 with the final state, and only the call that changed something is audited.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'The order, seen.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  acknowledgedAt: { type: 'string', format: 'date-time' }
                }
              }
            }
          }
        },
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },
};

module.exports = { core };
