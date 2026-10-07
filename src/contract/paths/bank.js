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
        'accepts a bank statement uploaded from the panel and works with every bank. `MERCANTIL_P2C` receives',
        'Mercantil\'s payment notifications: it needs the merchant\'s `merchantRif` and the `masterKey` Mercantil',
        'handed over, which is stored sealed and never returned; `path` is the one URL to give Mercantil.',
        'See docs/bank-connections.md.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object', required: ['kind', 'label'],
              properties: {
                kind: { type: 'string', enum: ['WEBHOOK', 'STATEMENT_IMPORT', 'MERCANTIL_P2C'] },
                label: { type: 'string', maxLength: 80 },
                bankCode: { type: ['string', 'null'], pattern: '^\\d{4}$' },
                merchantRif: { type: 'string', maxLength: 20, description: 'MERCANTIL_P2C only, and required there. «J-30724328-7», «J307243287» and «J000000307243287» are the same RIF.' },
                masterKey: { type: 'string', minLength: 8, maxLength: 512, writeOnly: true, description: 'MERCANTIL_P2C only, and required there. The key Mercantil gave the merchant. Write-only.' }
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
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bank-connections/{connectionId}': {
    patch: {
      tags: ['Bank connections'],
      summary: 'Rename, trust, map columns or remove',
      operationId: 'updateBankConnection',
      description: 'OWNER only. Turning `autoConfirm` on re-checks the pending claims at once, so what already matched is confirmed. `active: false` removes the connection; its movements stay. On a `MERCANTIL_P2C` connection, `merchantRif` and `masterKey` replace the RIF or the key (the test key for the production one); on any other kind they are a 409.',
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
                active: { type: 'boolean' },
                merchantRif: { type: 'string', maxLength: 20 },
                masterKey: { type: 'string', minLength: 8, maxLength: 512, writeOnly: true }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: { type: 'object', properties: { connection: ref('BankConnection') } } } } },
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
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

  '/api/v1/bank-inbound/mercantil': {
    post: {
      tags: ['Bank connections'],
      summary: 'Mercantil payment notifications (P2C), for every merchant',
      operationId: 'receiveMercantilNotification',
      description: [
        'Called by Mercantil, not by clients. The body is `{"data": "<base64>"}`, AES-encrypted with a key',
        'derived by SHA-256 from the merchant\'s master key; the `CompIdentif` header carries the merchant\'s',
        'RIF, which picks the `MERCANTIL_P2C` connection and so the key. A received, approved bolívar payment',
        'is stored as a movement and matched against pending claims. Answers Mercantil\'s envelope:',
        '`codigo` 0000 for stored (or "Operación duplicada" when already stored), and also 0000 for a',
        'notification that is not an incoming approved payment, which is acknowledged and ignored; 9999',
        'with 200 for one that decrypts but cannot be read. An unknown RIF, a key that does not open the',
        'message or, with `MERCANTIL_NOTIFY_ALLOWED_IPS` set, an unlisted IP is the same 401',
        '(`BANK_INBOUND_UNAUTHORIZED`), so the bank retries and nobody learns which RIFs exist.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'CompIdentif', in: 'header', required: true, schema: { type: 'string', example: 'J307243287' } }
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { type: 'string', format: 'byte' } } } } }
      },
      responses: {
        200: { description: 'Received, duplicate or ignored (`codigo` 0000), or unreadable (`codigo` 9999).', content: { 'application/json': { schema: ref('MercantilNotificationReply') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
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
