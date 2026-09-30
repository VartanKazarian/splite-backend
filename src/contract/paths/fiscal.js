'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Facturación fiscal.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const invoices = {

  '/api/v1/fiscal/invoices': {
    get: {
      tags: ['Fiscal'],
      summary: 'List issued invoices',
      operationId: 'listFiscalInvoices',
      description: [
        'Any signed-in member of staff, and **never gated by plan**. Issuing is a paid capability;',
        'reading a document already issued is not and cannot be. The legal duty to keep them',
        'outlives the subscription, and an invoice that became unreadable because an invoice went',
        'unpaid would be a problem Splite created.',
        '',
        'Newest first.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }
      ],
      responses: {
        200: {
          description: 'Issued invoices.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('FiscalInvoice') },
                  limit: { type: 'integer' },
                  offset: { type: 'integer' }
                }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/fiscal/invoices/{id}': {
    get: {
      tags: ['Fiscal'],
      summary: 'Read one invoice, with its lines and tax breakdown',
      operationId: 'getFiscalInvoice',
      description: [
        'Never gated by plan, for the reason on the list endpoint.',
        '',
        '`taxes` is separate from `lines` and is not derived from them: it is what the document',
        'declares. An AGGREGATE invoice has one line and still separates the 16% from the exempt',
        'part.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'The invoice.', content: { 'application/json': { schema: ref('FiscalInvoice') } } },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/fiscal/invoices/export': {
    get: {
      tags: ['Fiscal'],
      summary: "A month's fiscal documents as CSV, for the accountant",
      operationId: 'exportFiscalInvoices',
      description: [
        'One row per document issued in that month **in Caracas time**, with the base and VAT split',
        'by rate (one pair of columns per taxable rate that appears), exempt base, service and total.',
        'Credit notes carry negative amounts so a column sums to the month\'s net sales.',
        '',
        'Semicolon-separated, comma decimals, UTF-8 with BOM — what a Spanish-locale spreadsheet opens',
        'correctly. Text cells that a spreadsheet would read as a formula are neutralised with a',
        'leading apostrophe (customer names are typed by diners).',
        '',
        'A summary for the accountant, **not** the official libro de ventas. OWNER and MANAGER only:',
        'it lists every customer\'s tax id at once. Never gated by plan (it is a read).'
      ].join('\n'),
      security: staff,
      parameters: [{
        name: 'month', in: 'query', required: true,
        schema: { type: 'string', pattern: '^20\\d{2}-(0[1-9]|1[0-2])$', example: '2026-09' }
      }],
      responses: {
        200: { description: 'The CSV.', content: { 'text/csv': { schema: { type: 'string' } } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/fiscal/invoices/{id}/pdf': {
    get: {
      tags: ['Fiscal'],
      summary: 'Download one invoice as a PDF',
      operationId: 'downloadFiscalInvoicePdf',
      description: [
        'The same document the customer receives by email, rendered from the same query and the',
        'same formatting, so the two can never disagree. It changes nothing — a fiscal document is',
        'immutable — so it can be asked for as many times as needed. Never gated by plan, for the',
        'reason on the list endpoint: keeping invoices is the restaurant\'s duty and outlives the',
        'subscription.',
        '',
        'A document from the simulated provider carries a red "DOCUMENTO DE PRUEBA — NO ES UNA',
        'FACTURA FISCAL" banner, exactly as its email does.',
        '',
        'Sent as an attachment (`Content-Disposition`) named after the document number, with',
        '`Cache-Control: private, no-store`.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'The PDF.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/fiscal/requests': {
    get: {
      tags: ['Fiscal'],
      summary: 'The issuing queue',
      operationId: 'listFiscalRequests',
      description: [
        '`?status=UNCERTAIN` is the query that matters: attempts where the provider answered',
        'something that does not say whether it issued. Oldest first — the opposite of the invoice',
        'list — because a doubt from yesterday is more urgent than one from a minute ago.',
        '',
        'Not gated by plan: this is a read.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'SENT', 'ISSUED', 'FAILED', 'UNCERTAIN'] } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }
      ],
      responses: {
        200: {
          description: 'Issuing attempts.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('FiscalRequest') },
                  limit: { type: 'integer' },
                  offset: { type: 'integer' }
                }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/fiscal/requests/{id}/resolve': {
    post: {
      tags: ['Fiscal'],
      summary: 'Ask the provider what happened to an attempt in doubt',
      operationId: 'resolveFiscalRequest',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        '**This never re-requests issuance.** It asks the provider about the idempotency key. That',
        'is the only safe action on something that may already have been issued, which is why the',
        'route is called resolve and not retry — a duplicate invoice cannot be deleted and has',
        'already been declared.',
        '',
        'If the provider says it did issue, the document is recorded from the draft that was',
        '*sent*, not from a fresh computation: by now other diners have paid and the bill would',
        'produce a different draft.',
        '',
        '`stillUnknown` means the question could not be answered either, and the attempt stays in',
        'the queue. That is a correct outcome, not a failure.',
        '',
        'Gated by plan, because it can end up recording a document.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'What the provider said.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  requestId: { type: 'string', format: 'uuid' },
                  status: { type: 'string', enum: ['PENDING', 'SENT', 'ISSUED', 'FAILED', 'UNCERTAIN'] },
                  stillUnknown: { type: 'boolean' },
                  unchanged: { type: 'boolean', description: 'The attempt was not in doubt, so nothing was asked.' },
                  invoice: { oneOf: [ref('FiscalInvoice'), { type: 'null' }] }
                }
              }
            }
          }
        },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },
};

module.exports = { invoices };
