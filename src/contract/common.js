'use strict';

/**
 * Piezas compartidas del contrato: referencias, respuestas de error comunes, parámetros y esquemas de seguridad.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const response = name => ({ $ref: `#/components/responses/${name}` });

/** Minor units of currency, as a string so BIGINT survives JSON. */
const minorUnits = {
  type: 'string',
  pattern: '^[0-9]+$',
  description: 'Integer minor units (céntimos) as a string, so values beyond 2^53 survive JSON.',
  examples: ['756710']
};

const responses = {
  BadRequest: {
    description: 'Validation failed, or the body contradicts the path.',
    content: { 'application/json': { schema: ref('ValidationError') } }
  },
  Unauthorized: {
    description: 'Missing, malformed or expired credentials.',
    content: { 'application/json': { schema: ref('Error') } }
  },
  Forbidden: {
    description: 'Authenticated, but the role is not permitted, or the origin is not allowed by CORS.',
    content: { 'application/json': { schema: ref('Error') } }
  },
  NotFound: {
    description:
      'No such resource **inside the caller\'s restaurant**. A resource belonging to another tenant is reported as absent rather than forbidden, so the endpoint does not confirm it exists.',
    content: { 'application/json': { schema: ref('Error') } }
  },
  Conflict: {
    description: 'The request is valid but conflicts with current state.',
    content: { 'application/json': { schema: ref('Error') } }
  },
  TooManyRequests: {
    description: 'Rate limit exceeded, or the limiter is unavailable on a fail-closed surface.',
    headers: {
      'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until the window resets.' }
    },
    content: { 'application/json': { schema: ref('Error') } }
  },
  ServerError: {
    description: 'Unexpected failure. The message is never echoed; correlate using requestId.',
    content: { 'application/json': { schema: ref('Error') } }
  },
  ServiceUnavailable: {
    description: 'A dependency is unavailable.',
    content: { 'application/json': { schema: ref('Error') } }
  }
};

/** Every authenticated operation can produce these. */
const commonErrors = {
  400: response('BadRequest'),
  401: response('Unauthorized'),
  429: response('TooManyRequests'),
  500: response('ServerError')
};

const parameters = {
  BillId: {
    name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }
  },
  TableId: {
    name: 'tableId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }
  },
  BillItemId: {
    name: 'itemId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }
  },
  ProductId: {
    name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }
  },
  RestaurantId: {
    name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }
  },
  Limit: {
    name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
  },
  Offset: {
    name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 }
  },
  IdempotencyKey: {
    name: 'Idempotency-Key',
    in: 'header',
    required: false,
    schema: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
    description:
      'Takes precedence over `idempotencyKey` in the body. Replaying a completed key returns the stored response instead of charging again; reusing a key with a different payload is a 409.'
  }
};

const staff = [{ staffAuth: [] }];
const operator = [{ operatorAuth: [] }];

module.exports = { ref, response, minorUnits, responses, commonErrors, parameters, staff, operator };
