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
        'A guest order writes its lines straight onto the bill. This is the tray of "table 4 just ordered"',
        'notices, with what was ordered, so somebody can walk over or send it to the kitchen without',
        'opening the table to find out what it was.',
        '',
        'With approval of new phones on, it also holds the first order from each phone (`status: HELD`,',
        'listed first). Those are not on any bill yet: approve or reject them, `ack` refuses them.'
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

  '/api/v1/orders/settings': {
    get: {
      tags: ['Orders'],
      summary: 'Whether new phones need their first order approved',
      operationId: 'getGuestOrderSettings',
      description: 'Any staff role. Off by default.',
      security: staff,
      responses: {
        200: { description: 'The setting.', content: { 'application/json': { schema: { type: 'object', properties: { approveNewPhones: { type: 'boolean', description: 'Whether the first order from each new phone waits for the floor to approve it.' } } } } } },
        ...commonErrors
      }
    },
    patch: {
      tags: ['Orders'],
      summary: 'Turn approval of new phones on or off',
      operationId: 'updateGuestOrderSettings',
      description: [
        'OWNER or MANAGER. The QR is stuck to the table, so anyone who photographs it can order from',
        'outside — or open a bill on an empty table — as a prank. With this on, the first order from each',
        'phone waits for the floor; later ones from that phone go straight through.',
        '',
        'Turning it off leaves orders already held waiting: approve or reject them.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['approveNewPhones'], properties: { approveNewPhones: { type: 'boolean' } } } } }
      },
      responses: {
        200: { description: 'The setting, saved.', content: { 'application/json': { schema: { type: 'object', properties: { approveNewPhones: { type: 'boolean', description: 'Whether the first order from each new phone waits for the floor to approve it.' } } } } } },
        400: response('BadRequest'),
        ...commonErrors
      }
    }
  },

  '/api/v1/orders/{id}/approve': {
    post: {
      tags: ['Orders'],
      summary: 'Approve a held order',
      operationId: 'approveGuestOrder',
      description: [
        'Any staff role. The lines go onto the table\'s bill — opening one if the table is free — with the',
        'same checks as any order, and the phone that sent it orders without waiting from then on.',
        '',
        '`409 GUEST_ORDER_ALREADY_DECIDED` (with `status`) if it is no longer held. A product taken off',
        'the menu meanwhile fails the approval like any order would (`PRODUCT_INACTIVE`).'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'Approved and on the bill.',
          content: { 'application/json': { schema: { type: 'object', properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['PLACED'] },
            billId: { type: ['string', 'null'], format: 'uuid' }
          } } } }
        },
        404: response('NotFound'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/orders/{id}/reject': {
    post: {
      tags: ['Orders'],
      summary: 'Reject a held order',
      operationId: 'rejectGuestOrder',
      description: [
        'Any staff role. Nothing reaches a bill, and that phone cannot order again without scanning the',
        'table again. Idempotent: rejecting twice returns 200 both times.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'Rejected.',
          content: { 'application/json': { schema: { type: 'object', properties: {
            id: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['REJECTED'] },
            decidedAt: { type: 'string', format: 'date-time' }
          } } } }
        },
        404: response('NotFound'),
        409: response('Conflict'),
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
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },
};

module.exports = { core };
