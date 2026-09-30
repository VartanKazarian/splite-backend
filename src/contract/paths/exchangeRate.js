'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Tasa BCV.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {

  '/api/v1/exchange-rate': {
    get: {
      tags: ['Exchange rate'],
      summary: 'Official BCV reference rates (USD and EUR)',
      description:
        'Presentational. Returns 503 rather than a stale or invented rate when none is in force; payments are unaffected either way.',
      security: staff,
      responses: {
        200: { description: 'Rate in force.', content: { 'application/json': { schema: ref('ExchangeRate') } } },
        ...commonErrors,
        503: response('ServiceUnavailable')
      }
    }
  },
};

module.exports = { core };
