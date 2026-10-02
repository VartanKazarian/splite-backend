'use strict';

const { ref, response, minorUnits, commonErrors, staff } = require('../common');

/**
 * Lo que usa el comensal desde el QR de la mesa: sesión, cuenta, repartos, pedidos, avisos de pago y factura.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const qr = {

  '/api/v1/guest/qr/context': {
    post: {
      tags: ['Guest'],
      summary: 'What a scanned table QR points at, without opening a session',
      description: [
        'The landing a physical code leads to. Public, and it creates nothing.',
        '',
        'A printed QR previously had one thing it could do — mint a session — so a diner who',
        'scanned it to read the menu got a session anyway. The menu was unreachable regardless:',
        '`GET /api/v1/menu/public/{restaurantId}/products` is addressed by restaurant, and there',
        'was no way to learn a restaurant id without first taking a session. This returns one.',
        '',
        '**POST, not GET**, unlike the rest of the read surface: a token in the query string would',
        'be written to `req.url` in every access log line. It is a low-value credential printed on',
        'a table in a public room, but there is no reason to copy it into the logs to save a verb.',
        '',
        'Carries nothing about money. `hasOpenBill` says only what somebody standing in the room',
        'can see, and is there so the landing knows whether to offer the bill at all; the amount',
        'stays behind the session.',
        '',
        'Every rejection is `QR_INVALID` — bad signature, unknown table, deactivated table or',
        'restaurant, or a rotated nonce. Distinguishing them would answer questions about a',
        'restaurant for anyone holding a photograph of its furniture.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('GuestSessionRequest') } } },
      responses: {
        200: { description: 'The table the code names.', content: { 'application/json': { schema: ref('QrContext') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/sessions': {
    post: {
      tags: ['Guest'],
      summary: 'Exchange a signed table QR for a guest session',
      description:
        'The QR nonce is checked against the table, so a rotated or reprinted code stops working immediately.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('GuestSessionRequest') } } },
      responses: {
        201: { description: 'Guest session created.', content: { 'application/json': { schema: ref('GuestSession') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    },
    delete: {
      tags: ['Guest'],
      summary: 'End a guest session',
      description:
        'Always 204, whether or not the session existed, so it never confirms that a given session id was live.',
      security: [{ guestAuth: [] }],
      responses: {
        204: { description: 'Ended, or it was already gone.' },
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/bill': {
    get: {
      tags: ['Guest'],
      summary: 'The open bill for the guest\'s own table',
      operationId: 'getGuestBill',
      description: [
        'Authenticated with a guest session: `X-Guest-Session` plus the guest token as a bearer.',
        '',
        '**Takes no bill id.** The table comes from the session, which came from a signed QR, so',
        'a guest cannot request a bill that is not theirs -- there is no identifier to tamper with.',
        '',
        'Returns 404 when the table has no open bill, which is the normal state between sittings.',
        '',
        'Rate limited to 60 a minute **per guest session**, with a coarser per-address backstop',
        'in front of it. The per-address number is deliberately generous: a whole restaurant of',
        'diners arrives from one carrier NAT address, so a tight limit there throttles a busy',
        'Friday rather than an abuser.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      responses: {
        200: { description: 'The bill.', content: { 'application/json': { schema: ref('GuestBill') } } },
        401: response('Unauthorized'),
        404: response('NotFound'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/bill/splits': {
    post: {
      tags: ['Guest'],
      summary: 'Agree a persistent split of the guest\'s bill',
      operationId: 'createGuestSplit',
      description: [
        'Authenticated with a guest session. **Takes no bill id** \u2014 the table comes from the session.',
        '',
        'Stores an agreed split so each diner can then pay their own share (by Pago M\u00f3vil claim or',
        'C2P) and no one can pay more than their share. The shares sum to the outstanding balance by',
        'construction. One live split per bill: void the current one before agreeing another.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SplitPreviewRequest') } } },
      responses: {
        201: { description: 'The split was agreed and stored.', content: { 'application/json': { schema: ref('BillSplit') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/bill/splits/active': {
    get: {
      tags: ['Guest'],
      summary: 'The split currently governing the guest\'s bill',
      operationId: 'getGuestActiveSplit',
      description: [
        'Authenticated with a guest session.',
        '',
        'Returns the ACTIVE split, or the most recent STALE one if the bill changed after it was',
        'agreed — a diner who ordered another round needs to be told their split no longer covers the',
        'bill, not shown an empty screen. **Branch on `status`.** 404 means no split was ever agreed.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      responses: {
        200: { description: 'The active split.', content: { 'application/json': { schema: ref('BillSplit') } } },
        401: response('Unauthorized'),
        404: response('NotFound'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/bill/splits/active/participants/{ref}': {
    patch: {
      tags: ['Guest'],
      summary: "Name a share of the guest's bill split",
      operationId: 'nameGuestSplitShare',
      description: [
        'Authenticated with a guest session.',
        '',
        'The name is how the rest of the table sees who took which share. It used to be collected',
        'only from whoever CREATED the split, so a diner who arrived later and tapped a share was',
        'never asked, and the list read "Comensal 2" for almost everyone.',
        '',
        'Writable by anyone holding a guest session on that table — the same trust level that',
        'already creates and replaces a split, because the session belongs to the table, not to a',
        'person. Claiming otherwise would be inventing a guarantee that does not exist.',
        '',
        '**Stops being writable once that share has been paid into** (409 `SPLIT_HAS_PAYMENTS`).',
        'Same rule that governs the split itself, for the same reason: with no payments it is a',
        'proposal and gets corrected; with money behind it, it is the record of who paid, and',
        'letting somebody else rewrite it changes who a received payment is credited to.',
        '',
        'The empty string clears the name, so a typo can be undone without redoing the split.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: [
        {
          name: 'ref', in: 'path', required: true, schema: { type: 'string', maxLength: 64 },
          description: "The share's `ref`, as `GET /guest/bill/splits/active` returns it."
        }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object', required: ['name'],
              properties: {
                name: { type: 'string', maxLength: 80, description: 'Empty string clears it.' }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'The split, with the share renamed.', content: { 'application/json': { schema: ref('BillSplit') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/bill/split/preview': {
    post: {
      tags: ['Guest'],
      summary: 'Split the guest\'s own bill',
      operationId: 'previewGuestSplit',
      description: [
        'The same engine the staff endpoint uses, so a diner and a waiter looking at one bill are',
        'never shown two different allocations. **Advisory: it moves no money.**',
        '',
        'Scoped to the session\'s table, like every guest route.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SplitPreviewRequest') } } },
      responses: {
        200: { description: 'The allocation.', content: { 'application/json': { schema: ref('SplitPreview') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/tables/{tableId}/qr': {
    get: {
      tags: ['Guest'],
      summary: 'Mint a signed QR token for a table',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER. The table is resolved inside the caller\'s restaurant.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/TableId' }],
      responses: {
        200: { description: 'Signed QR token.', content: { 'application/json': { schema: ref('QrToken') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/guest/tables/{tableId}/qr/rotate': {
    post: {
      tags: ['Guest'],
      summary: 'Rotate a table QR nonce',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER. Invalidates every QR previously printed for the table.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/TableId' }],
      responses: {
        204: { description: 'Rotated.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },
};

const payments = {

  '/api/v1/guest/payments/{id}': {
    get: {
      tags: ['Guest'],
      summary: 'What became of a payment this diner declared',
      operationId: 'getGuestPaymentStatus',
      description: [
        'The diner declares a payment and the staff verify it. Without this read the phone had no',
        'way of learning that they had: the claim was held in memory as PENDING and stayed that',
        'way, so the screen promised an invoice "once the restaurant confirms your payment" and no',
        'path existed by which that promise could be kept.',
        '',
        'Returns the minimum — what state it is in and whether it already has an invoice. Nothing',
        'about the rest of the table: who else paid and how much is not the caller\'s business.',
        '',
        'Scoped like everything else on this surface: the payment must sit on a bill belonging to',
        'the scanning session\'s own table, and the caller has to know the UUID, which only whoever',
        'declared that payment receives. A payment from another table reads as absent.',
        '',
        '`billClosed` is not a problem — it is usually the signal that the invoice can now be asked',
        'for, since confirming the payment is what closes the bill.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'The payment, as its own payer may see it.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  status: { type: 'string', enum: ['PENDING', 'IN_DOUBT', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
                  amountVes: minorUnits,
                  billClosed: { type: 'boolean' },
                  invoiced: { type: 'boolean', description: 'True once a fiscal document exists for it, so the offer is not made twice.' },
                  invoice: {
                    oneOf: [{
                      type: 'object',
                      properties: {
                        controlNumber: { type: 'string' },
                        email: { type: ['string', 'null'], description: 'Where it is being delivered, if anywhere.' }
                      }
                    }, { type: 'null' }],
                    description: 'The fiscal invoice for this payment once it exists — including one issued on its own when the payment was confirmed, which the diner would otherwise have no way to see.'
                  },
                  invoiceRequest: {
                    oneOf: [{
                      type: 'object',
                      properties: {
                        email: { type: 'string' },
                        status: { type: 'string', enum: ['WAITING', 'ISSUED', 'FAILED', 'SKIPPED'] }
                      }
                    }, { type: 'null' }],
                    description: [
                      'The invoice asked for with the payment claim, if any. WAITING until the payment is',
                      'confirmed; ISSUED when it went out; SKIPPED when an invoice for this payment already',
                      'existed; FAILED when it could not be issued at confirmation — the moment to offer',
                      'asking for it by hand again.'
                    ].join('\n')
                  },
                  canRequestInvoice: {
                    type: 'boolean',
                    description: [
                      'Whether a fiscal invoice can be asked for at this restaurant at all. **Read it before',
                      'showing anything about invoicing**, including a "you will be able to ask once your',
                      'payment is confirmed" message: false means every such offer is a promise nothing can',
                      'keep, and a diner who waits on it is a diner who did not ask a member of staff while',
                      'they still could.',
                      '',
                      'It folds the refusals already knowable before anybody taps — the plan does not',
                      'include it (403 PLAN_UPGRADE_REQUIRED), the deployment has no issuer (503',
                      'FISCAL_PROVIDER_NOT_CONFIGURED), the restaurant has no RIF on file (409',
                      'FISCAL_RIF_MISSING), or it has not configured its authorised series (409',
                      'FISCAL_SERIES_MISSING) — into one answer, deliberately without saying which. Which',
                      'one it is concerns the restaurant, not the diner, and what the diner should do is',
                      'the same in every case: ask a member of staff before leaving.',
                      '',
                      'It rides here rather than on the bill because the bill closes exactly when the',
                      'invoice becomes askable, so a flag living there would vanish at the one moment it is',
                      'needed.',
                      '',
                      'True is not a guarantee: the payment still has to be settled and the bill must have',
                      'something left to declare. It only means the offer is honest.'
                    ].join('\n')
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

  '/api/v1/guest/payments/{id}/receipt': {
    get: {
      tags: ['Guest'],
      summary: 'The receipt for a payment: the whole bill, then your share of it',
      operationId: 'getGuestReceipt',
      description: [
        '**The whole table\'s bill, and only then "you paid X".** Every product with its quantity',
        'and unit price, the subtotal, the service charge, the VAT broken out by rate, and the',
        'total — followed by what this one diner put in.',
        '',
        'That ordering is the product decision. Four receipts from a table of four have to line up',
        'and tell the same dinner: same products, same subtotal, same VAT, same total, with only',
        'the last block differing. A receipt showing just one person\'s share lets them check',
        'nothing — not that they were charged for what they ordered, nor that the parts sum to the',
        'whole.',
        '',
        'So the `bill` block is derived from the bill alone. It takes no payment, cannot vary',
        'between diners, and there is a test that fixes it.',
        '',
        '**This is not a fiscal invoice.** A receipt evidences that a charge happened. It carries',
        'no control number, no authorised printer issued it, and it does not serve to deduct tax.',
        'The fiscal invoice is a separate document requested separately.',
        '',
        'Anchored to the payment rather than to the open bill, for the same reason the invoice is:',
        'the receipt is read right after the charge is confirmed, which is the instant the bill',
        'closes.',
        '',
        'Scoped like everything else here: the payment must sit on a bill belonging to the scanning',
        'session\'s own table. A payment from another table reads as absent.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
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

  '/api/v1/guest/bill/contact': {
    post: {
      tags: ['Guest'],
      summary: 'Leave an email for the invoice',
      operationId: 'saveGuestContact',
      description: [
        'The address is asked for with a concrete reason -- so the invoice can arrive -- and the',
        'restaurant would also like to send promotions. **Those are two purposes**, and this',
        'endpoint stores them as two things.',
        '',
        '`marketingConsent` reaches true only when the person in front ticked an empty box. There',
        'is no default and no inference from the address being present: a transactional detail must',
        'not become a mailing list because nobody said no.',
        '',
        'Not gated by plan. Leaving your email is not a capability that is sold, and a diner has no',
        'business finding out what their restaurant has subscribed to.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('GuestContactRequest') } } },
      responses: {
        201: { description: 'Stored.', content: { 'application/json': { schema: ref('GuestContactResponse') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/guest/bill/invoice': {
    post: {
      tags: ['Guest'],
      summary: 'Ask for a fiscal invoice',
      operationId: 'requestGuestInvoice',
      description: [
        'Offered after paying, beside the receipt, once the money has moved. A tax form before',
        'payment turns a dinner into paperwork, and most people do not need one.',
        '',
        '**Consumidor final is the main path, not the exception.** A body carrying only `paymentId`',
        'is complete. Do not render the recipient fields as a form to be filled in.',
        '',
        'The bill comes from the QR session, so a diner can only invoice a payment on their own',
        'table — there is no field in which to name another.',
        '',
        'Requires the restaurant to be on a plan that includes `fiscalInvoicing` (403',
        '`PLAN_UPGRADE_REQUIRED`) and the deployment to have an issuer configured (503',
        '`FISCAL_PROVIDER_NOT_CONFIGURED`).',
        '',
        'Where the deployment issues by its own means, the restaurant must also have its',
        'authorised series on file. Two 409s come from that and **neither is worth retrying** —',
        'retrying changes nothing, and a client should say so rather than offer a retry button:',
        '`FISCAL_SERIES_MISSING` (the restaurant has not configured one; its owner has to) and',
        '`FISCAL_RANGE_EXHAUSTED` (the authorised range ran out, and a new one has to be',
        'requested — `details.lastAuthorised` carries the last number covered).',
        '',
        '**A failure here never means the payment failed.** 202 with `UNCERTAIN` means the provider',
        'answered something that does not say whether it issued; it goes to a queue a person looks',
        'at, and blindly retrying would risk declaring the sale twice.',
        '',
        'Asking twice for the same payment — two taps, or a retry after a dropped connection —',
        'answers 409 `FISCAL_ALREADY_REQUESTED`. One payment, one document: that was already',
        'guaranteed by a unique index, but the collision used to surface as a bare 500, leaving a',
        'client unable to tell the diner the one thing worth saying, which is that their invoice is',
        'already on file.',
        '',
        '**Only 202 `UNCERTAIN` means "pending, somebody is looking at it".** Every other',
        'non-success is a refusal, and a client must not present them as an invoice in progress:',
        'no request row exists, no queue entry exists, and nobody is resolving anything.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('RequestInvoiceRequest') } } },
      responses: {
        201: { description: 'Issued.', content: { 'application/json': { schema: ref('RequestInvoiceResponse') } } },
        202: { description: 'Not issued: in doubt, or refused by the provider. No document exists.', content: { 'application/json': { schema: ref('RequestInvoiceResponse') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        503: response('ServiceUnavailable')
      }
    }
  },
};

const bill = {

  '/api/v1/guest/bill/orders': {
    post: {
      tags: ['Guest'],
      summary: 'Order from the table',
      operationId: 'placeGuestOrder',
      description: [
        'The lines go straight onto the table\'s bill — nobody approves them first — and the floor is',
        'told by the notice the order leaves behind (`GET /api/v1/orders`). A diner who orders from',
        'their seat should not wait on a waiter tapping accept on another screen.',
        '',
        'Neither the table nor the restaurant is in the body: both come from the guest session, which was',
        'created by verifying the QR signature. There is no field in which to name somebody else\'s table.',
        '',
        'If the table has no open bill, the first order opens one, exactly as a waiter taking the first',
        'order does. `served_by` stays null: nobody from the house took this order, and putting a name',
        'there would move tips toward someone who did not.',
        '',
        'Bounded harder than the staff order endpoint — 20 lines of up to 20 units, against 50 of 999.',
        'The QR is stuck to the table and anyone who photographs it can open a session, so the room worth',
        'leaving is a table\'s order, not four hundred portions. Rate limited to 10 per minute per session.',
        '',
        '`403 SUBSCRIPTION_SUSPENDED` when the order would open a new bill and Splite suspended the',
        'restaurant\'s subscription. A table that already has a bill keeps ordering and paying.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['items'],
              properties: {
                items: {
                  type: 'array', minItems: 1, maxItems: 20,
                  items: {
                    type: 'object',
                    required: ['productId'],
                    properties: {
                      productId: { type: 'string', format: 'uuid' },
                      quantity: { type: 'integer', minimum: 1, maximum: 20, default: 1 }
                    }
                  }
                },
                note: {
                  type: ['string', 'null'], maxLength: 200,
                  description: 'A note for the floor ("no onion on the burger"). Trimmed; empty is the same as absent. One per order rather than per line. Control characters other than a newline are refused.'
                }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Received. Nothing to follow: what was ordered is already on the diner\'s bill.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  orderId: { type: 'string', format: 'uuid' },
                  createdAt: { type: 'string', format: 'date-time' },
                  lineCount: { type: 'integer' }
                }
              }
            }
          }
        },
        403: response('Forbidden'),
        ...commonErrors
      }
    }
  },

  '/api/v1/guest/bill/payment-claims': {
    post: {
      tags: ['Guest'],
      summary: 'Declare a Pago Móvil the diner has already sent',
      operationId: 'declarePaymentClaim',
      description: [
        'Authenticated with a guest session. **Takes no bill id** — the table comes from the session.',
        '',
        'Creates a claim and settles nothing. The money went from the diner\'s bank to the',
        'restaurant\'s without passing through Splite, so no API of ours can see it arrive; the only',
        'honest thing this can do is carry the diner\'s word to somebody who can check the bank app.',
        '',
        '`bills.amountPaidVes` is untouched until a member of staff confirms it through',
        '`POST /api/v1/payments/claims/{id}/confirm`. A bill that showed itself as paid because',
        'somebody typed a number into a form would be worse than one showing nothing, because the',
        'restaurant would stop asking.',
        '',
        'A claim is not a reservation: two diners may each claim the whole balance, and only the',
        'first confirmation can succeed.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('DeclareClaimRequest') } } },
      responses: {
        201: { description: 'Claim recorded, awaiting verification.', content: { 'application/json': { schema: ref('PaymentClaim') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },
};

const banks = {

  '/api/v1/guest/banks': {
    get: {
      tags: ['Guest'],
      summary: 'Venezuelan banks, for the diner to pick their own',
      operationId: 'listGuestBanks',
      description: [
        'The same public list `GET /api/v1/account/banks` serves staff, behind a guest session.',
        'Nothing about the restaurant or the table is in it.',
        '',
        '**Render `bankOrigin` as a picker fed by this, never as a free-text field.** That field on',
        '`POST /guest/bill/payment-claims` is optional corroboration, but when present the server',
        'only accepts a four-digit code from this list — "Banesco", "banesco" and "BANESCO 0134" are',
        'one bank that compares as three, and the person paying for the difference is the one',
        'verifying against a bank app. A text box therefore turns an *optional* field into a 400',
        'that stops the diner paying at all, which is what happened before this endpoint existed:',
        'the error even read "pick it from the list" and there was no list a diner could reach.',
        '',
        'An empty selection sends no `bankOrigin`, which is always valid.',
        '',
        '**The list is not officially sourced.** It has been cross-checked against two independent',
        'published lists, which agreed on every code, but the BCV register itself has not been read.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      responses: {
        200: {
          description: 'Banks, ordered by name.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        code: { type: 'string' },
                        name: { type: 'string' },
                        chargeable: { type: 'boolean' }
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
  },

  '/api/v1/guest/c2p/banks': {
    get: {
      tags: ['Guest'],
      summary: 'How to obtain a C2P clave, per bank',
      operationId: 'listC2PBankClaves',
      description: [
        'Authenticated with a guest session. Static reference data: the channels, SMS short codes and',
        'bodies, and clave lifetime for every bank Splite can charge by C2P.',
        '',
        'The step of the C2P flow Splite does not control is the diner asking their own bank for a',
        'single-use clave. `strategy.when` is the field to act on — a clave that lasts five minutes',
        '(Banplus) or is bound to the amount (100% Banco) must be fetched at payment time, not when',
        'the diner sits down.',
        '',
        'Optional `idType` and `idNumber` fill the diner\'s identity into the SMS bodies that take it.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: [
        { name: 'idType', in: 'query', schema: { type: 'string', enum: ['V', 'E', 'J', 'G', 'P', 'C'] } },
        { name: 'idNumber', in: 'query', schema: { type: 'string', pattern: '^[0-9]{6,9}$' } }
      ],
      responses: {
        200: {
          description: 'The clave guide, one entry per chargeable bank, ordered by name.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('C2PBankClave') } }
              }
            }
          }
        },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/guest/bill/c2p': {
    post: {
      tags: ['Guest'],
      summary: 'Charge the diner\'s bank account by C2P',
      operationId: 'chargeC2P',
      description: [
        'Authenticated with a guest session. **Takes no bill id** — the table comes from the session.',
        '',
        'Unlike `payment-claims`, this moves money. The diner supplies a single-use clave from their',
        'own bank and Splite asks Mercantil to pull the amount, so the response is an outcome rather',
        'than a message to staff.',
        '',
        '**Handle all four statuses.** `IN_DOUBT` is the one that matters: the bank did not tell us',
        'what happened, the debit may have landed, and Mercantil does not promise that invoice',
        'numbers deduplicate. Offering a retry there is how a diner pays twice for one dinner.',
        '',
        'Rate limited far more tightly than the rest of the guest surface — 8 per 5 minutes per',
        'session — because each attempt burns a clave the diner had to fetch from their bank and',
        'consumes the restaurant\'s quota with Mercantil.',
        '',
        '`Idempotency-Key` is mandatory. A client that never saw the response replays the original',
        'outcome instead of raising a second charge.',
        '',
        '**This rail is off on a deployment that has not been wired to a bank.** It needs three',
        'things, not one: `MERCANTIL_C2P_URL` on the server, credentials stored for the restaurant,',
        'and those credentials proven by a real call — `enabled` is only ever set by a successful',
        'one, so a mistyped key cannot leave the rail switched on and quietly broken. Missing any of',
        'them answers 503 `PAYMENT_PROVIDER_MISCONFIGURED`, which is configuration rather than a',
        'transient fault. Read `chargeable` on `GET /api/v1/account/banks` before offering this, and',
        'fall back to a declared Pago Móvil — that rail needs no configuration at all.'
      ].join('\n'),
      security: [{ guestAuth: [] }],
      parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('C2PChargeRequest') } } },
      responses: {
        201: { description: 'The charge was raised. Read `status` for what happened.', content: { 'application/json': { schema: ref('C2PChargeResult') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        404: response('NotFound'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },
};

module.exports = { qr, payments, bill, banks };
