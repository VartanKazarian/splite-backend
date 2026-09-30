'use strict';

const { ref, response } = require('../common');

/**
 * Sondas de vida y de disponibilidad.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {
  '/health/live': {
    get: {
      tags: ['Health'],
      summary: 'Liveness probe',
      description: 'Stays 200 during a graceful shutdown so the orchestrator lets the process drain.',
      security: [],
      responses: {
        200: { description: 'Process is alive.', content: { 'application/json': { schema: ref('Liveness') } } }
      }
    }
  },

  '/health/ready': {
    get: {
      tags: ['Health'],
      summary: 'Readiness probe',
      description: 'Reports 503 as soon as a shutdown begins, so traffic drains before connections close.',
      security: [],
      responses: {
        200: { description: 'Dependencies reachable.', content: { 'application/json': { schema: ref('Readiness') } } },
        503: response('ServiceUnavailable')
      }
    }
  },
};

module.exports = { core };
