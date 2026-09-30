'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Conexiones bancarias: movimientos por webhook firmado o estado de cuenta.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {

  '/api/v1/bank-connections': {
    get: {
      tags: ['Bank connections'],
      summary: 'The restaurant\'s bank connections',
      operationId: 'listBankConnections',
      description: 'OWNER, MANAGER and CASHIER — the people who verify payments.',
      security: staff,
      responses: {
        200: { description: 'Active connections.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('BankConnection') } } } } } },
        403: response('Forbidden'),
        ...commonErrors
      }
    },
    post: {
      tags: ['Bank connections'],
      summary: 'Connect a source of bank movements',
      operationId: 'createBankConnection',
      description: [
        'OWNER only. `WEBHOOK` accepts signed pushes from any system (a verification service, a bank-email',
        'forwarder, a script) at `path`; the response carries the signing `secret` **once**. `STATEMENT_IMPORT`',
        'accepts a bank statement uploaded from the panel and works with every bank. See docs/bank-connections.md.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object', required: ['kind', 'label'],
              properties: {
                kind: { type: 'string', enum: ['WEBHOOK', 'STATEMENT_IMPORT'] },
                label: { type: 'string', maxLength: 80 },
                bankCode: { type: ['string', 'null'], pattern: '^\\d{4}$' }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Created.',
          content: { 'application/json': { schema: { type: 'object', properties: { connection: ref('BankConnection'), secret: { type: 'string' }, path: { type: 'string' } } } } }
        },
        403: response('Forbidden'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bank-connections/{connectionId}': {
    patch: {
      tags: ['Bank connections'],
      summary: 'Rename, trust, map columns or remove',
      operationId: 'updateBankConnection',
      description: 'OWNER only. Turning `autoConfirm` on re-checks the pending claims at once, so what already matched is confirmed. `active: false` removes the connection; its movements stay.',
      security: staff,
      parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                label: { type: 'string', maxLength: 80 },
                autoConfirm: { type: 'boolean' },
                columnMap: { type: ['object', 'null'] },
                active: { type: 'boolean' }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: { type: 'object', properties: { connection: ref('BankConnection') } } } } },
        403: response('Forbidden'),
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bank-connections/{connectionId}/rotate-secret': {
    post: {
      tags: ['Bank connections'],
      summary: 'Issue a new signing secret for a webhook connection',
      operationId: 'rotateBankConnectionSecret',
      description: 'OWNER only. The old secret stops working at once. Returned once, like at creation.',
      security: staff,
      parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'The new secret.', content: { 'application/json': { schema: { type: 'object', properties: { connection: ref('BankConnection'), secret: { type: 'string' }, path: { type: 'string' } } } } } },
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bank-connections/{connectionId}/import': {
    post: {
      tags: ['Bank connections'],
      summary: 'Import movements from a bank statement',
      operationId: 'importBankMovements',
      description: [
        'OWNER, MANAGER and CASHIER, on a STATEMENT_IMPORT connection. The panel splits the file into',
        'columns and sends up to 500 rows per call; each row is validated on its own, so unreadable rows',
        'come back with a reason and do not stop the others. Idempotent: the same statement twice adds nothing.',
        'After storing, every pending Pago Móvil claim is checked again.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['movements'], properties: { movements: { type: 'array', minItems: 1, maxItems: 500, items: ref('BankMovementInput') }, columnMap: { type: ['object', 'null'], description: 'Optional: remember which column holds each value, for the next upload.' } } } } }
      },
      responses: {
        200: { description: 'What was stored and what matched.', content: { 'application/json': { schema: ref('BankIngestResult') } } },
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bank-connections/{connectionId}/movements': {
    get: {
      tags: ['Bank connections'],
      summary: 'Recent movements from one connection',
      operationId: 'listBankMovements',
      description: 'The last 50, newest first — to check that movements are arriving.',
      security: staff,
      parameters: [{ name: 'connectionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Movements.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: ref('BankMovement') } } } } } },
        403: response('Forbidden'),
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bank-inbound/{connectionId}': {
    post: {
      tags: ['Bank connections'],
      summary: 'Push bank movements, signed',
      operationId: 'pushBankMovements',
      description: [
        'For machines, no session. Two headers: `X-Splite-Timestamp` (Unix seconds) and',
        '`X-Splite-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`. The signature',
        'covers the exact bytes sent. More than 5 minutes off is rejected. An unknown connection, a',
        'wrong signature and a stale timestamp all answer the same 401. Retrying is safe: movements are',
        'idempotent. Up to 500 per call. See docs/bank-connections.md for a worked example.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'connectionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'X-Splite-Timestamp', in: 'header', required: true, schema: { type: 'string', pattern: '^\\d+$' } },
        { name: 'X-Splite-Signature', in: 'header', required: true, schema: { type: 'string', pattern: '^sha256=[0-9a-f]{64}$' } }
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['movements'], properties: { movements: { type: 'array', minItems: 1, maxItems: 500, items: ref('BankMovementInput') } } } } }
      },
      responses: {
        200: { description: 'What was stored and what matched.', content: { 'application/json': { schema: ref('BankIngestResult') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },
};

module.exports = { core };
