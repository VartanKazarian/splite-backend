'use strict';

const { commonErrors } = require('../common');

/**
 * Lo que cuenta el navegador: errores y velocidad (FR4).
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */
const core = {
  '/api/v1/client-events': {
    post: {
      tags: ['Health'],
      summary: 'Report a browser error or a Web Vitals sample',
      operationId: 'reportClientEvent',
      description: [
        'No session: a diner without an account fails too. 30 per minute per IP, 12 KB body.',
        'Sent as `text/plain` holding JSON (a CORS "simple" request, which is all a',
        '`fetch(…, { keepalive: true })` on page exit can send); `application/json` is accepted too.',
        '',
        '`error` events are stored one row per fingerprint per day and listed in',
        '`GET /api/v1/admin/client-errors`; `vital` events only go to the log (`WEB_VITAL`).',
        'Paths are stripped of query and fragment, and QR and receipt tokens are replaced.'
      ].join('\n'),
      security: [],
      requestBody: {
        required: true,
        content: {
          'text/plain': { schema: { type: 'string', description: 'JSON of the object below.' } },
          'application/json': {
            schema: {
              type: 'object',
              required: ['kind'],
              properties: {
                kind: { type: 'string', enum: ['error', 'vital'] },
                path: { type: 'string', maxLength: 500 },
                surface: { type: 'string', enum: ['guest', 'staff', 'public', 'admin'] },
                release: { type: 'string', maxLength: 60 },
                message: { type: 'string', maxLength: 2000, description: 'error only' },
                stack: { type: 'string', maxLength: 8000, description: 'error only' },
                name: { type: 'string', enum: ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'], description: 'vital only' },
                value: { type: 'number', description: 'vital only: ms, or the unitless CLS score' },
                rating: { type: 'string', enum: ['good', 'needs-improvement', 'poor'] },
                connection: { type: 'string', maxLength: 20, description: 'navigator.connection.effectiveType' }
              }
            }
          }
        }
      },
      responses: { 204: { description: 'Recorded.' }, ...commonErrors }
    }
  }
};

module.exports = { core };
