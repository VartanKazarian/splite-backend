'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Después de pagar (R20): la opinión del comensal y el recibo que se manda por
 * WhatsApp; y, en el panel, lo que opinan.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const paymentId = [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }];

const core = {

  '/api/v1/guest/payments/{id}/feedback': {
    post: {
      tags: ['Guest'],
      summary: 'Rate the meal after paying',
      operationId: 'rateGuestPayment',
      description: [
        'One rating per diner per bill: rating again corrects it instead of adding another. The',
        'payment must be on the scanning session\'s own bill and must have gone through (PENDING or',
        'SUCCEEDED); a rejected one answers 409 `PAYMENT_NOT_RATEABLE`.',
        '',
        '**The Google link goes to everyone who rates, whatever the stars.** Inviting only happy',
        'diners is what Google calls selectively soliciting positive reviews; it is against its',
        'policy and can cost the restaurant its reviews. The stars and comment are stored privately',
        'for the restaurant either way.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: paymentId,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['rating'],
              additionalProperties: false,
              properties: {
                rating: { type: 'integer', minimum: 1, maximum: 5 },
                comment: { type: 'string', maxLength: 500 }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Stored.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['googleReviewUrl'],
                properties: {
                  googleReviewUrl: {
                    type: ['string', 'null'], format: 'uri',
                    description: 'Where to leave a Google review, if the restaurant has set one.'
                  }
                }
              }
            }
          }
        },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/guest/payments/{id}/receipt-link': {
    post: {
      tags: ['Guest'],
      summary: 'A link to this receipt, to send to yourself on WhatsApp',
      operationId: 'createGuestReceiptLink',
      description: [
        'The phone\'s receipt opens only with the table session, which expires and stays in that',
        'browser. This returns a signed token that opens the same receipt without a session, from',
        'anywhere, for 180 days: the page is `/recibo/{token}` on the frontend, which reads',
        '`GET /api/v1/receipts/{token}`. Nothing is stored; the signature is the permission.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: paymentId,
      responses: {
        200: {
          description: 'The link token.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'expiresAt'],
                properties: {
                  token: { type: 'string' },
                  expiresAt: { type: 'string', format: 'date-time' }
                }
              }
            }
          }
        },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/receipts/{token}': {
    get: {
      tags: ['Guest'],
      summary: 'A receipt opened from a shared link',
      operationId: 'getSharedReceipt',
      description: [
        'No session: the signed token is the permission. The same receipt as',
        '`GET /api/v1/guest/payments/{id}/receipt`, except that the bank reference is cut to its',
        'last four digits (`…1234`): a link gets forwarded and sits in chats, and the full',
        'reference has no reason to travel with it.',
        '',
        'A forged, mangled or expired link answers 404 `RECEIPT_LINK_INVALID`, the same as a',
        'payment that does not exist, so it does not say which of the three it was.'
      ].join('\n'),
      security: [],
      parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string', maxLength: 600 } }],
      responses: {
        200: {
          description: 'The receipt.',
          content: { 'application/json': { schema: ref('GuestReceipt') } }
        },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/feedback': {
    get: {
      tags: ['Feedback'],
      summary: 'What diners said after paying',
      operationId: 'getFeedback',
      description: 'OWNER and MANAGER. The average, how many of each rating, and the latest 50 with their table and date. Nothing about the diner is stored, so nothing about them is returned.',
      security: staff,
      parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 30 } }],
      responses: {
        200: {
          description: 'The summary.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['days', 'count', 'average', 'distribution', 'recent'],
                properties: {
                  days: { type: 'integer' },
                  count: { type: 'integer' },
                  average: { type: ['number', 'null'], description: 'One decimal; null with no ratings.' },
                  distribution: {
                    type: 'object',
                    properties: { 1: { type: 'integer' }, 2: { type: 'integer' }, 3: { type: 'integer' }, 4: { type: 'integer' }, 5: { type: 'integer' } }
                  },
                  recent: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['id', 'rating', 'comment', 'tableName', 'createdAt'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        rating: { type: 'integer', minimum: 1, maximum: 5 },
                        comment: { type: ['string', 'null'] },
                        tableName: { type: ['string', 'null'] },
                        createdAt: { type: 'string', format: 'date-time' }
                      }
                    }
                  }
                }
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
