'use strict';

const { ref, response, commonErrors, staff } = require('../common');

/**
 * Cuentas: abrir, líneas, repartos, cobro y cierre.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const core = {

  '/api/v1/bills': {
    get: {
      tags: ['Bills'],
      summary: 'List bills',
      description: 'Any authenticated staff role. Scoped to the caller\'s restaurant.',
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'status', in: 'query', schema: { type: 'string', enum: ['OPEN', 'CLOSED', 'VOID'] } },
        { name: 'tableId', in: 'query', schema: { type: 'string', format: 'uuid' } }
      ],
      responses: {
        200: { description: 'Bills.', content: { 'application/json': { schema: ref('BillList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Bills'],
      summary: 'Open a bill for a table',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description:
        'Roles: OWNER, MANAGER, CASHIER, WAITER. A table may have only one OPEN bill; a second attempt returns 409 `OPEN_BILL_EXISTS` with the existing bill id.',
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('CreateBillRequest') } } },
      responses: {
        201: { description: 'Bill opened.', content: { 'application/json': { schema: ref('Bill') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/tables/{tableId}/open': {
    get: {
      tags: ['Bills'],
      summary: 'Resolve a table to its current open bill',
      description: 'What a client scanning a permanent table QR calls. Any authenticated staff role.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/TableId' }],
      responses: {
        200: { description: 'The open bill.', content: { 'application/json': { schema: ref('Bill') } } },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/bills/tables/{tableId}/order': {
    post: {
      tags: ['Bills'],
      summary: 'Take an order for a table',
      operationId: 'orderForTable',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER, WAITER. **Opens the table\'s bill if it does not have one**,',
        'then adds every line in a single transaction.',
        '',
        'This is the shape of the work: a waiter has a table and a list of things, not a bill id.',
        'Doing it with the primitives means asking whether a bill exists, creating one if not, and',
        'posting each line — and leaving half an order behind if one call fails.',
        '',
        '`opened` says whether this call started the bill, so the UI can say "table opened" rather',
        'than guessing. Prices are snapshotted per line, as everywhere else.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/TableId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('OrderRequest') } } },
      responses: {
        201: { description: 'Order taken.', content: { 'application/json': { schema: ref('OrderResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/bills/{id}/server': {
    patch: {
      tags: ['Bills'],
      summary: 'Correct who served a table, or claim one nobody is down for',
      operationId: 'setBillServer',
      description: [
        'Two acts behind one endpoint, with two different rules.',
        '',
        '**Correcting is OWNER and MANAGER, and audited, because it moves money between people.**',
        '`servedBy` is set automatically when a bill is opened, to whoever opened it. That is right',
        'when the person taking the order opens the bill and wrong when a host or a cashier opens it',
        'on somebody else\'s behalf — common enough to need a correction path rather than an',
        'assumption. Tips are attributed through the bill\'s **current** server, so a correction here',
        'moves the tips that followed from it: a correction leaving yesterday\'s money against the',
        'wrong name would not be one. It is also why a waiter cannot do this to their own tables.',
        '',
        '**Claiming is any staff role, only ever themselves, and only while the bill has nobody.**',
        'It takes nothing from anyone: an unattributed bill\'s tips sit in the "no server" bucket,',
        'owed to nobody in particular, so moving them to whoever actually served the table is the',
        'correction that bucket exists to make possible. It is here because of the QR — a diner',
        'ordering from their phone opens the bill with no server, and the person who knows who is',
        'serving that table is the waiter walking over. Requiring a manager first is how a shift ends',
        'with a pile of unattributed cash. Naming somebody else, or clearing the field, is still a',
        'correction and still needs the two roles: `FORBIDDEN_ROLE`. A bill somebody already holds',
        'answers `BILL_ALREADY_SERVED`, and the current server is read `FOR UPDATE`, so two waiters',
        'claiming the same table serialise rather than overwrite each other.',
        '',
        '`servedBy: null` clears it — better for a bill to belong to nobody than to the wrong person.',
        'An inactive account is refused with `STAFF_NOT_FOUND`, so somebody who has left cannot',
        'quietly be given a share.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['servedBy'],
              properties: {
                servedBy: {
                  type: ['string', 'null'], format: 'uuid',
                  description: 'Null is meaningful and distinct from omitting the field: it detaches the bill from anybody.'
                }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'The bill, reattributed.', content: { 'application/json': { schema: ref('Bill') } } },
        403: response('Forbidden'),
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/bills/{id}': {
    get: {
      tags: ['Bills'],
      summary: 'Read a bill',
      description: 'Any authenticated staff role.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      responses: {
        200: {
          description: 'The bill, with its line items.',
          content: { 'application/json': { schema: ref('BillWithItems') } }
        },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/bills/{id}/items': {
    get: {
      tags: ['Bills'],
      summary: 'List the lines on a bill',
      description: 'Any authenticated staff role.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      responses: {
        200: { description: 'Lines.', content: { 'application/json': { schema: ref('BillItemList') } } },
        ...commonErrors,
        404: response('NotFound')
      }
    },
    post: {
      tags: ['Bills'],
      summary: 'Add a line to a bill',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER, WAITER.',
        '',
        'The product name and price are **snapshotted** onto the line, so later menu changes',
        'never alter a bill already served. Adding the same product twice creates two lines: a',
        'second round may have been ordered at a different price.',
        '',
        'The bill total is recomputed from its lines and re-converted at the rate **frozen when',
        'the bill opened**, never at the current rate.',
        '',
        'Only an OPEN bill accepts lines. A bill opened with a fixed non-zero total is refused',
        'with 409 `BILL_NOT_ITEMISED`; open it with a total of 0 to itemise it.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('AddBillItemRequest') } } },
      responses: {
        201: { description: 'Line added.', content: { 'application/json': { schema: ref('BillItemMutation') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/items/{itemId}': {
    patch: {
      tags: ['Bills'],
      summary: 'Change a line quantity',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description:
        'Roles: OWNER, MANAGER, CASHIER, WAITER. The snapshotted unit price is never revisited; only the quantity changes.',
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/BillId' },
        { $ref: '#/components/parameters/BillItemId' }
      ],
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateBillItemRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('BillItemMutation') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    },
    delete: {
      tags: ['Bills'],
      summary: 'Remove a line from a bill',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER, WAITER.',
        '',
        'Refused with 409 `TOTAL_BELOW_AMOUNT_PAID` when it would drop the bill total below what',
        'has already been settled — reversing money that has moved is a refund, not an edit.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/BillId' },
        { $ref: '#/components/parameters/BillItemId' }
      ],
      responses: {
        200: { description: 'Removed.', content: { 'application/json': { schema: ref('BillItemRemoval') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/splits': {
    post: {
      tags: ['Bills'],
      summary: 'Agree a persistent split of a bill',
      operationId: 'createBillSplit',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER, WAITER.',
        '',
        'The advisory preview computes the same numbers; this stores them, so a group settles',
        'against one agreed plan from several phones. Shares sum to the outstanding balance by',
        'construction, and the database refuses a split that does not. One live split per bill \u2014',
        '409 `SPLIT_ALREADY_EXISTS` until the current one is voided.',
        '',
        'The bill must be **OPEN**: 409 `BILL_NOT_OPEN` otherwise. A split of a closed or voided',
        'bill is a plan nobody can settle — the shares compute, and then every payment against',
        'them is refused, one diner at a time, at the till.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SplitPreviewRequest') } } },
      responses: {
        201: { description: 'The split was agreed and stored.', content: { 'application/json': { schema: ref('BillSplit') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/splits/active': {
    get: {
      tags: ['Bills'],
      summary: 'The split currently governing the bill',
      operationId: 'getBillActiveSplit',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER, WAITER.',
        '',
        'Returns the ACTIVE split, or the most recent STALE one if the bill changed after a split',
        'was agreed. **Branch on `status`** — a STALE split is returned precisely so a client can say',
        '"the bill changed, agree a new split" rather than showing nothing. 404 means this bill never',
        'had one.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      responses: {
        200: { description: 'The active split.', content: { 'application/json': { schema: ref('BillSplit') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/bills/{id}/splits/{splitId}/void': {
    post: {
      tags: ['Bills'],
      summary: 'Void a split',
      operationId: 'voidBillSplit',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER.',
        '',
        'Refused once any share has been paid into \u2014 409 `SPLIT_HAS_PAYMENTS`. A plan people have',
        'started settling against is a record, not a draft; change it by agreeing a fresh split on the',
        'remaining balance.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/BillId' },
        { name: 'splitId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      responses: {
        200: { description: 'The split, now VOID.', content: { 'application/json': { schema: ref('BillSplit') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/split/preview': {
    post: {
      tags: ['Bills'],
      summary: 'Compute an exact split of the outstanding balance',
      operationId: 'previewSplit',
      description: [
        'Any authenticated staff role. **Advisory: this mutates nothing.** Payment still goes',
        'through the payments endpoint, which holds the bill lock and enforces the ceiling.',
        '',
        '**Every mode divides the same figure** — the outstanding VES balance — echoed back as',
        '`outstandingVes`, so a client never has to work out which number was split.',
        '',
        'Allocation is largest-remainder, so the parts sum to exactly the total. Rounding each',
        'share independently would leave the last diner unable to pay under',
        '`CHECK (amount_paid_ves <= total_due_ves)`. `totalAllocatedVes` is returned so a client',
        'can assert that rather than trust it.',
        '',
        'POST because the intent does not fit in a query string, not because anything is written.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SplitPreviewRequest') } } },
      responses: {
        200: { description: 'The allocation.', content: { 'application/json': { schema: ref('SplitPreview') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/void': {
    post: {
      tags: ['Bills'],
      summary: 'Void an unpaid bill',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description:
        'Roles: OWNER, MANAGER. Refused once any payment has been applied: reversing money that has moved is a refund, not a status change.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      responses: {
        200: { description: 'Voided.', content: { 'application/json': { schema: ref('Bill') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/settle': {
    post: {
      tags: ['Bills'],
      summary: 'Close a bill with what was actually collected',
      operationId: 'settleBill',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        '**Roles: OWNER, MANAGER**, and audited, because this forgives money.',
        '',
        'A bill used to leave `OPEN` by exactly two routes, and between them is a gap a dining room',
        'falls through. It becomes `CLOSED` on its own only when what was collected equals what was',
        'owed **to the céntimo**; and it can be voided only while not a céntimo has arrived',
        '(`BILL_HAS_PAYMENTS` otherwise). So a table that pays 2.000 of 2.330 and leaves, a courtesy',
        'on a bill that already took a payment, a dish sent back after paying, or one zero too many',
        'while typing, could **never be closed**: voiding is refused because money moved, and',
        'removing lines to square it is refused with `TOTAL_BELOW_AMOUNT_PAID`. The table stayed',
        'occupied on the floor for ever, and its balance stayed in the panel\'s outstanding figure.',
        '',
        'This closes it and records the difference with a reason and an author.',
        '',
        '**It does not touch `amountPaidVes`.** What was collected comes from the payment ledger and',
        'is what gets compared against the bank and the till; adding a payment nobody made would',
        'square the bill and unbalance the count, which is worse. The bill closes with',
        '`amountPaidVes < totalDueVes`, and the difference lives in the adjustment.',
        '',
        'A bill that owes nothing is simply closed, with `adjustment: null` — closing something that',
        'owes nothing is closing it, not forgiving zero.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/BillId' }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['reason'],
              properties: {
                reason: {
                  type: 'string',
                  enum: ['DISCOUNT', 'COMP', 'WRITE_OFF'],
                  description: 'Required on purpose: it is the only thing separating a negotiated reduction from a courtesy and from bad debt, and a default would make the three the same.'
                },
                note: { type: 'string', maxLength: 280, description: 'Optional and short — "they left without paying", "table 4 birthday". What a figure needs to still mean something a month later.' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'The closed bill, and what was written off.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  bill: ref('Bill'),
                  adjustment: {
                    oneOf: [ref('BillAdjustment'), { type: 'null' }],
                    description: 'Null when the bill owed nothing.'
                  }
                }
              }
            }
          }
        },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/bills/{id}/payments': {
    post: {
      tags: ['Payments'],
      summary: 'Apply a payment to a bill',
      operationId: 'applyPayment',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Settlement is **always VES**. USD appears in the response as a display reference only.',
        '',
        '**Roles:** OWNER, MANAGER, CASHIER.',
        '',
        '**Idempotency.** Supply `Idempotency-Key` (or `idempotencyKey` in the body). Replaying a',
        'completed key returns the stored response rather than charging again. Reusing a key with a',
        'different payload, or while the first request is still in flight, is a 409.',
        '',
        '**Concurrency.** The bill row is locked for the duration, so simultaneous splits serialise',
        'and cannot overpay. The display rate was frozen when the bill was opened, so every',
        'split reports the same figure and nothing drifts mid-meal.',
        '',
        '**FX is never load-bearing.** If no verified rate is available the payment still applies and',
        'the USD reference is null.',
        '',
        '**Rate limited** to 60/minute per authenticated user.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/BillId' },
        { $ref: '#/components/parameters/IdempotencyKey' }
      ],
      requestBody: { required: true, content: { 'application/json': { schema: ref('PaymentRequest') } } },
      responses: {
        200: {
          description:
            'Payment applied, or the stored response replayed for a repeated idempotency key.',
          content: { 'application/json': { schema: ref('PaymentResult') } }
        },
        400: {
          description: 'Validation failed, or `billId` does not match the path.',
          content: { 'application/json': { schema: ref('ValidationError') } }
        },
        401: response('Unauthorized'),
        403: response('Forbidden'),
        404: response('NotFound'),
        409: {
          description: [
            'One of: the payment exceeds the remaining balance; the bill is not OPEN; the idempotency',
            'key was reused with a different payload; or a request with that key is still in flight.'
          ].join(' '),
          content: { 'application/json': { schema: ref('Error') } }
        },
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },
};

module.exports = { core };
