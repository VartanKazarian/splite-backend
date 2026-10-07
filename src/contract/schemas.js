'use strict';

const { CODES } = require('../errors');
const { ref, minorUnits } = require('./common');

/**
 * Los esquemas del contrato (`components.schemas`), incluidos los del alta de restaurantes.
 *
 * Una parte del documento OpenAPI. Lo ensambla `src/openapi.js`, que explica
 * qué es y cómo se comprueba.
 */

const schemas = {
  // Every failure in the API is this object and nothing else. `error` used to
  // be a string on some routes, `{ message, requestId }` on others and an array
  // of validation strings on a third set, with `code` and `billId` as siblings
  // rather than inside it -- so a client could not destructure a failure without
  // first knowing which route produced it.
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'details', 'requestId'],
        properties: {
          code: {
            type: 'string',
            enum: Object.keys(CODES),
            description:
              'Stable identifier for what went wrong. Branch on this, never on `message`. A code always carries the same HTTP status.'
          },
          message: {
            type: 'string',
            description:
              'Human-readable and subject to change without notice. Never parse it. 5xx messages are always the literal string "Internal Server Error".'
          },
          details: {
            type: 'object',
            additionalProperties: true,
            description:
              'Structured context for this code, always present and possibly empty. See x-error-details for what each code carries.'
          },
          requestId: {
            type: 'string',
            description: 'Correlates with the server log line for this failure. Quote it in bug reports.'
          }
        }
      }
    }
  },

  // Kept as a distinct name because a validation failure is the one error with
  // a documented `details` payload clients routinely render field by field.
  ValidationError: {
    allOf: [
      ref('Error'),
      {
        type: 'object',
        description: [
          'code is always VALIDATION_FAILED.',
          '',
          '`details.fields` carries one human-readable entry per failed field, and',
          '`details.fieldPaths` the names of the fields those entries came from.',
          '',
          'Use `fieldPaths` to mark a form: the messages are Joi\'s and come in several shapes —',
          'some open with the field name in quotes, some without them, and a custom message may not',
          'name the field at all — so a client that parses them marks the wrong box. `fieldPaths`',
          'comes from the validator\'s own path and does not depend on how a message is worded.'
        ].join('\n'),
        properties: {
          error: {
            type: 'object',
            properties: {
              details: {
                type: 'object',
                properties: {
                  fields: { type: 'array', items: { type: 'string' } },
                  fieldPaths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Field names, deduplicated. Nested fields are dotted.'
                  }
                }
              }
            }
          }
        }
      }
    ]
  },

  Bill: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      restaurantId: { type: 'string', format: 'uuid' },
      tableId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['OPEN', 'CLOSED', 'VOID'] },
      servedBy: {
        type: ['string', 'null'], format: 'uuid',
        description: 'The member of staff this bill is attributed to for tips. Set to whoever opened it, correctable at PATCH /api/v1/bills/{id}/server. Null for bills that predate the column and for ones deliberately detached.'
      },
      subtotalMinor: { ...minorUnits, description: 'Sum of the line items, before charges.' },
      vatBps: {
        type: 'integer', minimum: 0, maximum: 10000,
        description: 'The restaurant\'s general IVA rate in basis points, frozen when the bill opened. 1600 = 16%. It is the default a line inherits, not necessarily the rate every line paid: a product can be exempt, or carry a rate of its own. Read the per-line taxCategory and vatBps to see what was applied, and do not recompute vatMinor from this field.'
      },
      vatMinor: { ...minorUnits, description: 'IVA, taken on the subtotal alone — never on the service charge. Computed per rate: lines are grouped by the rate frozen on each, the rate is applied once per group, and the groups are summed. With a single rate — which is every bill that predates per-product tax categories — that is arithmetically identical to applying it to the whole subtotal.' },
      serviceChargeBps: {
        type: 'integer', minimum: 0, maximum: 10000,
        description: 'Servicio rate in basis points, frozen when the bill opened. 1000 = 10%.'
      },
      serviceChargeMinor: { ...minorUnits, description: 'Servicio, taken on the subtotal. Not taxed.' },
      totalDue: {
        ...minorUnits,
        description: 'subtotalMinor + vatMinor + serviceChargeMinor, in the menu currency. The database refuses a row where those disagree.'
      },
      currency: {
        type: 'string', enum: ['VES', 'USD', 'EUR'],
        description: 'The currency the menu quoted. Settlement is always VES.'
      },
      totalDueVes: { ...minorUnits, description: 'Authoritative amount to settle.' },
      amountPaidVes: { ...minorUnits, description: 'Authoritative amount settled so far.' },
      remainingVes: minorUnits,
      fxRateVesPerUnit: {
        type: ['string', 'null'],
        pattern: '^\\d+\\.\\d{8}$',
        description: 'VES per unit of menu currency, padded to 8 decimal places. Frozen when the bill was opened.',
        examples: ['757.54060000']
      },
      fxRateSource: { type: ['string', 'null'] },
      fxValueDate: {
        type: ['string', 'null'],
        format: 'date',
        description: 'Calendar date only. Never a timestamp: a zone offset here can shift the BCV value date by a day.',
        examples: ['2025-03-06']
      },
      calculationVersion: { type: 'integer' },
      usdReference: ref('UsdReference'),
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  BillItem: {
    type: 'object',
    description:
      'A line on a bill. The price is snapshotted when the line is added, so re-pricing, renaming or deactivating the product never changes a bill already served.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      billId: { type: 'string', format: 'uuid' },
      productId: {
        type: ['string', 'null'], format: 'uuid',
        description: 'Reporting link only. Null once the product is gone; the line outlives it.'
      },
      name: { type: 'string', description: 'The product name as it was when the line was added.' },
      unitPriceMinor: { ...minorUnits, description: 'Snapshotted unit price, in the bill currency.' },
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      quantity: { type: 'integer', minimum: 1, maximum: 999 },
      subtotalMinor: { ...minorUnits, description: 'unitPriceMinor x quantity, computed by the database.' },
      taxCategory: {
        type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'],
        description: 'The tax treatment frozen onto the line when it was added, like the price and for the same reason: changing a product\'s category tomorrow must not move the IVA on a meal already eaten.'
      },
      vatBps: {
        type: 'integer', minimum: 0, maximum: 10000,
        description: 'The rate actually applied to this line, in basis points. Already resolved — unlike the product\'s, this is never null, because the restaurant can change its general rate and this line cannot. Zero for anything not taxable.'
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  BillWithItems: {
    allOf: [
      ref('Bill'),
      {
        type: 'object',
        description: 'Returned by single-bill reads. The list endpoint returns Bill, without lines.',
        properties: {
          itemCount: { type: 'integer' },
          items: { type: 'array', items: ref('BillItem') }
        }
      }
    ]
  },

  BillItemList: {
    type: 'object',
    properties: { data: { type: 'array', items: ref('BillItem') } }
  },

  BillItemMutation: {
    type: 'object',
    description: 'The affected line and the recalculated bill, so a client never re-derives a total.',
    properties: {
      item: ref('BillItem'),
      bill: ref('Bill')
    }
  },

  BillItemRemoval: {
    type: 'object',
    properties: {
      removedId: { type: 'string', format: 'uuid' },
      bill: ref('Bill')
    }
  },

  OrderRequest: {
    type: 'object',
    required: ['items'],
    description: 'What a table just ordered. One call, however many things.',
    properties: {
      items: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object',
          required: ['productId'],
          properties: {
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1, maximum: 999, default: 1 }
          }
        }
      }
    }
  },

  OrderResult: {
    type: 'object',
    properties: {
      opened: { type: 'boolean', description: 'True when this order opened the table\'s bill.' },
      bill: ref('BillWithItems')
    }
  },

  AddBillItemRequest: {
    type: 'object',
    required: ['productId'],
    properties: {
      productId: { type: 'string', format: 'uuid' },
      quantity: { type: 'integer', minimum: 1, maximum: 999, default: 1 }
    }
  },

  UpdateBillItemRequest: {
    type: 'object',
    required: ['quantity'],
    properties: { quantity: { type: 'integer', minimum: 1, maximum: 999 } }
  },

  UsdReference: {
    type: 'object',
    description:
      'Presentational only. Null throughout when no verified rate was available; settlement is unaffected.',
    properties: {
      totalDue: { type: ['string', 'null'] },
      amountPaid: { type: ['string', 'null'] },
      remaining: { type: ['string', 'null'] }
    }
  },

  BillList: {
    type: 'object',
    properties: {
      data: { type: 'array', items: ref('Bill') },
      limit: { type: 'integer' },
      offset: { type: 'integer' }
    }
  },

  CreateBillRequest: {
    type: 'object',
    required: ['tableId', 'totalDueMinorUnits'],
    properties: {
      tableId: { type: 'string', format: 'uuid' },
      totalDueMinorUnits: {
        ...minorUnits,
        description: 'Minor units in the restaurant menu currency, which the bill inherits.'
      }
    }
  },

  PaymentRequest: {
    type: 'object',
    required: ['billId', 'amountMinorUnits', 'currency', 'idempotencyKey'],
    properties: {
      billId: {
        type: 'string',
        format: 'uuid',
        description: 'Must equal the id in the path; a mismatch is a 400.'
      },
      amountMinorUnits: {
        type: 'string',
        pattern: '^[0-9]{1,18}$',
        description:
          'VES céntimos as a digit string, so a payment can be as large as the column holds. A JSON number is accepted for convenience but is rejected beyond 2^53, where it has already lost precision.',
        examples: ['250000']
      },
      currency: {
        type: 'string',
        const: 'VES',
        description: 'Settlement is VES only. USD appears in responses as a reference, never as a payment.'
      },
      idempotencyKey: {
        type: 'string',
        minLength: 16,
        maxLength: 128,
        pattern: '^[A-Za-z0-9._:-]+$',
        description: 'Used when the Idempotency-Key header is absent.'
      },
      splitParticipantId: {
        type: 'string', format: 'uuid',
        description: 'Optional. Settle one participant share of a persistent split; the payment may not exceed what is left on that share, and is refused with 409 SPLIT_STALE if the bill changed after the split was agreed.'
      },
      tipMinorUnits: {
        ...minorUnits,
        description: 'Optional voluntary tip, default 0. Added to what the payer hands over, **never to the bill** — `amountMinorUnits` alone settles it.'
      },
      paymentMethod: {
        type: 'string',
        enum: ['CASH', 'CARD', 'TRANSFER', 'SPLITE', 'OTHER'],
        default: 'SPLITE',
        description:
          'Optional. How the money arrived at the till. Send it when a tip is involved: it is what separates a cash tip already in the drawer from an electronic one the restaurant owes its staff, and an unset method is reported as unclassified rather than guessed. `C2P` and `PAGO_MOVIL` are not accepted here — those are set by the rails that own them.'
      }
    }
  },

  PaymentResult: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      paymentId: { type: 'string', format: 'uuid', description: 'The ledger row this payment created.' },
      status: { type: 'string', enum: ['OPEN', 'CLOSED'] },
      currency: { type: 'string', const: 'VES' },
      totalDue: minorUnits,
      amountPaid: minorUnits,
      remaining: minorUnits,
      displayCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      fxRate: {
        type: ['string', 'null'],
        pattern: '^\\d+\\.\\d{8}$',
        description: 'VES per unit of display currency, padded to 8 decimal places.',
        examples: ['757.54060000']
      },
      fxSource: { type: ['string', 'null'] },
      usdReference: ref('UsdReference'),
      tipVes: { ...minorUnits, description: 'The tip on this payment. Excluded from every bill figure above.' },
      totalChargedVes: { ...minorUnits, description: 'What the payer actually handed over: the settled amount plus the tip.' },
      shareDetached: {
        type: 'string',
        enum: ['SPLIT_STALE', 'SPLIT_NOT_ACTIVE', 'SPLIT_SHARE_OVERPAID', 'SPLIT_SHARE_NOT_FOUND'],
        description:
          'Present only when a confirmed claim reached the bill but could not be credited to the share it named — the split went stale or was voided while the claim sat in the queue. The money is settled; the split will still show that diner as owing, and this says why.'
      }
    }
  },

  SplitPreviewRequest: {
    type: 'object',
    required: ['mode', 'participants'],
    properties: {
      mode: {
        type: 'string',
        enum: ['FULL', 'EQUAL', 'ITEMS', 'CUSTOM'],
        description:
          'FULL: one participant owes the balance. EQUAL: divided evenly. ITEMS: participants claim lines, shared lines split between claimants. CUSTOM: the client states amounts, which must add up exactly.'
      },
      participants: {
        type: 'array', minItems: 1, maxItems: 50,
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: {
              type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9._:-]+$',
              description: 'Client-owned and opaque to the server. Must be unique within the request.'
            },
            name: { type: 'string', maxLength: 80 },
            amountVes: { ...minorUnits, description: 'CUSTOM only. Must sum to outstandingVes exactly.' }
          }
        }
      },
      claims: {
        type: 'array', maxItems: 500,
        description:
          'ITEMS only. Every line on the bill must appear, or the split is refused. A line may appear more than once, once per group of units claimed, in which case every claim on it carries a quantity and they must add up to the units on the line.',
        items: {
          type: 'object',
          required: ['itemId', 'participantIds'],
          properties: {
            itemId: { type: 'string', format: 'uuid' },
            quantity: {
              type: 'integer', minimum: 1, maximum: 999,
              description:
                'How many of the line\u2019s units this claim covers. Omit to claim the whole line, which is the only meaning available before quantities existed. When a line is claimed more than once, the quantities across its claims must sum to the line\u2019s quantity.'
            },
            participantIds: {
              type: 'array', minItems: 1, items: { type: 'string' },
              description: 'More than one splits this claim evenly between them.'
            }
          }
        }
      }
    }
  },

  SplitPreview: {
    type: 'object',
    properties: {
      billId: { type: 'string', format: 'uuid' },
      mode: { type: 'string', enum: ['FULL', 'EQUAL', 'ITEMS', 'CUSTOM'] },
      currency: { type: 'string', const: 'VES' },
      outstandingVes: { ...minorUnits, description: 'What was divided. Every mode divides this same figure.' },
      totalAllocatedVes: {
        ...minorUnits,
        description: 'Always equal to outstandingVes. Present so a client can assert it rather than trust it.'
      },
      allocations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            participantId: { type: 'string' },
            name: { type: ['string', 'null'] },
            amountVes: minorUnits,
            usdReference: { type: ['string', 'null'] }
          }
        }
      }
    }
  },

  BillSplit: {
    type: 'object',
    description:
      'A persistent split: an agreed plan for who pays which part of a bill. The participant shares sum to basisVes, the outstanding balance when the split was agreed, and each share is paid down independently under its own ceiling. Not a second source of truth for how much the bill has been paid.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      billId: { type: 'string', format: 'uuid' },
      mode: { type: 'string', enum: ['FULL', 'EQUAL', 'ITEMS', 'CUSTOM'] },
      status: {
        type: 'string', enum: ['ACTIVE', 'STALE', 'VOID'],
        description:
          'ACTIVE governs the bill. STALE means the bill total changed after the split was agreed — it takes no further payments and the group must agree another; money already paid into it stays on the bill. VOID was discarded deliberately, which is only possible while nothing had been paid in.'
      },
      currency: { type: 'string', const: 'VES' },
      basisVes: { ...minorUnits, description: 'The outstanding balance the shares divide. Frozen at creation, so it does not follow a bill that changes afterwards — that is what STALE records.' },
      createdByType: { type: 'string', enum: ['STAFF', 'GUEST'] },
      participants: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'The persisted share id. Cite it on a payment to settle this share.' },
            ref: { type: 'string', description: 'The client-supplied participant label the split was created with.' },
            name: { type: ['string', 'null'] },
            amountVes: { ...minorUnits, description: 'The assigned share.' },
            amountPaidVes: { ...minorUnits, description: 'How much of the share has settled.' },
            remainingVes: minorUnits,
            settled: { type: 'boolean' },
            usdReference: { type: ['string', 'null'] }
          }
        }
      },
      claims: {
        type: 'array',
        description:
          'ITEMS only. Who is on which line \u2014 one entry per (line, participant), even where the request claimed the line by units across several claims. What each of them owes is in `participants`.',
        items: {
          type: 'object',
          properties: {
            billItemId: { type: 'string', format: 'uuid' },
            participantId: { type: 'string', format: 'uuid' }
          }
        }
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  ClaimsSummary: {
    type: 'object',
    description:
      'The two numbers a screen needs to say somebody is waiting, without opening the queue. Cheap enough to poll — one indexed aggregate — but poll at a human interval (15–30s), not per second: this shares the API rate limit with everything else the till is doing.',
    properties: {
      pending: { type: 'integer', description: 'Declared payments awaiting verification.' },
      oldestPendingAt: { type: ['string', 'null'], format: 'date-time', description: 'When the longest-waiting claim was declared. Null when the queue is empty.' },
      oldestPendingAgeSeconds: {
        type: ['integer', 'null'],
        description:
          'How long that claim has been waiting, computed server-side so a skewed client clock cannot turn a fresh claim into an alarming one. This is the figure worth showing: a count alone cannot tell a claim that arrived ten seconds ago from one ignored for an hour, and the second is a diner who has probably left believing they paid.'
      }
    }
  },

  TipsReport: {
    type: 'object',
    description:
      'Tips over a period, and how they arrived. The split by arrival is the point: a cash tip is already in the till, an electronic one is a debt to staff until it is paid out.',
    properties: {
      from: { type: 'string', format: 'date-time', description: 'Inclusive.' },
      to: { type: 'string', format: 'date-time', description: 'Exclusive, so consecutive shifts tile without double-counting.' },
      currency: { type: 'string', const: 'VES' },
      totalTipsVes: minorUnits,
      inTillVes: { ...minorUnits, description: 'Tips taken as cash. The money is physically present; only its division is open.' },
      owedToStaffVes: { ...minorUnits, description: 'Tips that arrived electronically (CARD, TRANSFER, PAGO_MOVIL, C2P), so the restaurant holds them and owes them out.' },
      unclassifiedVes: {
        ...minorUnits,
        description:
          'Tips on payments whose method was not recorded (SPLITE, OTHER). Reported separately rather than folded into either figure above: calling them cash cancels a real debt to staff, and calling them electronic pays out money already in the drawer. The three always sum to `totalTipsVes`.'
      },
      billedVes: { ...minorUnits, description: 'What was billed alongside these tips — the denominator of the rate.' },
      tipRateBps: {
        type: ['integer', 'null'],
        description: 'Tips as basis points of what was billed: 840 is 8.40%. **This is the figure that answers "is tipping working here"** — a total alone cannot, because a bigger number on a busier night says nothing. Null when nothing was billed; zero would read as "nobody tipped", which is a different fact about a shift.'
      },
      byServer: {
        type: 'array',
        description: 'Tips by the person the bill is attributed to. Attribution is read through `bills.servedBy` **at query time**, so a manager correcting who served a table moves the tips with it — a correction that left the money against the wrong name would not be one. A bill with no server is reported under a null `userId` rather than dropped, or the parts would stop summing to the total.',
        items: {
          type: 'object',
          properties: {
            userId: { type: ['string', 'null'], format: 'uuid' },
            email: { type: ['string', 'null'] },
            payments: { type: 'integer' },
            tipsVes: minorUnits,
            billedVes: minorUnits,
            tipRateBps: { type: ['integer', 'null'] }
          }
        }
      },
      unassigned: {
        type: 'array',
        description:
          'The bills behind the null-`userId` row of `byServer`, so it can be acted on rather than only read. A figure cannot be corrected: it says money has no owner without saying which tables it came from — and by the time anybody reads this report, at the end of a shift, those bills are closed and appear on no other screen, so `PATCH /bills/{id}/server` had no way to learn an id. Bills rather than payments, because attribution belongs to the bill: one person serves a table however many times it pays. Capped at 50; the totals stay in `byServer`, so a short list never makes a figure wrong. Empty unless something is actually unassigned.',
        items: {
          type: 'object',
          properties: {
            billId: { type: 'string', format: 'uuid' },
            tableId: { type: ['string', 'null'], format: 'uuid' },
            tableName: { type: ['string', 'null'], description: 'Null when the table was deleted afterwards. The bill and its tip are still real, so the row stays.' },
            status: { type: 'string', description: 'OPEN, CLOSED or VOID — an open one can also be fixed from the floor.' },
            payments: { type: 'integer' },
            tipsVes: minorUnits,
            billedVes: minorUnits,
            lastPaidAt: { type: 'string', format: 'date-time' }
          }
        }
      },
      byMethod: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            paymentMethod: { type: 'string' },
            payments: { type: 'integer' },
            tipsVes: minorUnits
          }
        }
      }
    }
  },

  MenuOcrDraft: {
    type: 'object',
    description:
      'What a vision model read off an uploaded menu. A **draft**: nothing has been written. Every row carries the price as printed alongside the parsed value, because the reviewer is checking one against the other.',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 160 },
            description: { type: ['string', 'null'], maxLength: 500 },
            section: { type: ['string', 'null'], description: 'The heading it appeared under, e.g. "Entradas".' },
            priceText: { type: ['string', 'null'], description: 'Exactly as printed on the menu — "12,50", "Bs. 8,00".' },
            priceMinorUnits: {
              type: ['string', 'null'], pattern: '^[0-9]+$',
              description: 'The parsed price, or null when it could not be read. Null is a result, not an error: that row needs a human.'
            },
            needsPrice: { type: 'boolean', description: 'True when priceMinorUnits is null. Block import until it is fixed or the row is removed.' },
            duplicateName: {
              type: 'boolean',
              description: 'True when another drafted row shares this name. The menu is unique on (restaurant, name), so one must be renamed before import.'
            },
            currency: { type: 'string', enum: ['VES', 'USD', 'EUR'], description: "The restaurant's menu currency, not the model's guess." }
          }
        }
      },
      pages: { type: 'integer', description: 'Pages read. Always 1 for an image; up to MENU_OCR_MAX_PDF_PAGES for a PDF.' },
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'], description: "The restaurant's configured menu currency. Prices import in this." },
      currencyGuess: {
        type: ['string', 'null'],
        description: 'What the model thought the menu was priced in. **Reported, never applied** — a menu printed in dollars does not change what this restaurant charges in. A mismatch is for the reviewer to notice.'
      },
      notes: { type: ['string', 'null'], description: 'Anything the model could not read.' },
      needsReview: { type: 'integer', description: 'Rows flagged with needsPrice or duplicateName.' }
    }
  },

  MenuOcrImportRequest: {
    type: 'object',
    required: ['items'],
    description:
      'The items a staff member confirmed. Validated exactly like hand-typed products — the extraction carries no authority here, and this body is equally valid having uploaded nothing.',
    properties: {
      items: {
        type: 'array', minItems: 1, maxItems: 200,
        items: {
          type: 'object',
          required: ['name', 'priceMinorUnits'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 160 },
            description: { type: ['string', 'null'], maxLength: 500 },
            priceMinorUnits: { ...minorUnits, description: 'Zero is allowed: a garnish or a refill can be free.' },
            section: {
              type: ['string', 'null'], maxLength: 80,
              description: 'The heading the reader found, passed back from the draft. Matched to a section by name; a new one is created at the end of the menu, in the order sections first appear here.'
            }
          }
        }
      }
    }
  },

  MenuOcrImportResult: {
    type: 'object',
    description:
      'Partial success is normal. Each row is inserted in its own savepoint, so a duplicate name rejects that row and keeps the rest.',
    properties: {
      importedCount: { type: 'integer' },
      categoriesCreated: {
        type: 'array', items: ref('MenuCategory'),
        description: 'Sections this import created. Six named after the menu means the structure was read; none means the photo had no headings the reader could find.'
      },
      items: { type: 'array', items: ref('Product') },
      errors: {
        type: 'array',
        description: 'Rows that were not imported, by their index in the request.',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            name: { type: 'string' },
            code: { type: 'string', enum: ['PRODUCT_NAME_TAKEN'] },
            message: { type: 'string' }
          }
        }
      }
    }
  },

  GuestBill: {
    type: 'object',
    description:
      'A bill as a diner sees it. Narrower than Bill: internal identifiers and rate provenance are withheld, since this is the least trusted surface in the API.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tableId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['OPEN'] },
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      subtotalMinor: { ...minorUnits, description: 'Sum of the line items, before charges.' },
      vatBps: {
        type: 'integer', minimum: 0, maximum: 10000,
        description: 'The restaurant\'s general IVA rate in basis points, frozen when the bill opened. 1600 = 16%. It is the default a line inherits, not necessarily the rate every line paid: a product can be exempt, or carry a rate of its own. Read the per-line taxCategory and vatBps to see what was applied, and do not recompute vatMinor from this field.'
      },
      vatMinor: { ...minorUnits, description: 'IVA, taken on the subtotal alone — never on the service charge. Computed per rate: lines are grouped by the rate frozen on each, the rate is applied once per group, and the groups are summed. With a single rate — which is every bill that predates per-product tax categories — that is arithmetically identical to applying it to the whole subtotal.' },
      serviceChargeBps: {
        type: 'integer', minimum: 0, maximum: 10000,
        description: 'Servicio rate in basis points, frozen when the bill opened. 1000 = 10%.'
      },
      serviceChargeMinor: { ...minorUnits, description: 'Servicio, taken on the subtotal. Not taxed.' },
      totalDue: {
        ...minorUnits,
        description: 'subtotalMinor + vatMinor + serviceChargeMinor, in the menu currency.'
      },
      totalDueVes: { ...minorUnits, description: 'Authoritative amount to settle.' },
      amountPaidVes: minorUnits,
      remainingVes: minorUnits,
      fxRateVesPerUnit: {
        type: ['string', 'null'],
        pattern: '^\\d+\\.\\d{8}$',
        description: 'Frozen when the bill opened. Present so a client can show an approximate menu-currency figure.'
      },
      usdReference: ref('UsdReference'),
      itemCount: { type: 'integer' },
      items: { type: 'array', items: ref('BillItem') },
      payee: {
        oneOf: [ref('GuestPayee'), { type: 'null' }],
        description: 'Who to pay. Null when the restaurant has not configured a payee, in which case the diner cannot pay from their phone at all — the bill can be read and not settled.'
      },
      c2pAvailable: {
        type: 'boolean',
        description: [
          'Whether this restaurant can take a C2P charge right now: the rail is configured and its',
          'credentials are stored and enabled. **Offer C2P only when this is true.**',
          '',
          'It exists because the alternative is a dead end the diner pays for. The C2P form asks for',
          'a single-use clave they must fetch from their own bank, and without the rail the charge is',
          'refused with 503 `PAYMENT_PROVIDER_MISCONFIGURED` once they have done all of the work.',
          '',
          'Do not infer this from `chargeable` on the bank list. That flag answers a different',
          'question — which integration module is mapped to a bank code — and is false for every bank',
          'today, including the one whose restaurants can charge perfectly well.'
        ].join('\n')
      },
      canRequestInvoice: {
        type: 'boolean',
        description: [
          'Whether this restaurant can issue a fiscal invoice from the app — the same answer as',
          '`canRequestInvoice` on `GET /guest/payments/{id}`, available here before anything is paid.',
          '**Offer "send me the invoice" on the payment claim only when this is true.**',
          '',
          'The payment status keeps its own copy because the bill stops being readable the moment',
          'it closes, which is exactly when a manually requested invoice becomes possible.'
        ].join('\n')
      },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  Table: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      restaurantId: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      active: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  FloorTable: {
    allOf: [
      ref('Table'),
      {
        type: 'object',
        description: 'A table with whatever bill is open on it. `openBill` is null when the table is free — never absent.',
        properties: {
          openBill: {
            type: ['object', 'null'],
            description: 'Summary only: enough to render a floor plan, without the line items.',
            properties: {
              id: { type: 'string', format: 'uuid' },
              status: { type: 'string', enum: ['OPEN'] },
              currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
              subtotalMinor: minorUnits,
              vatBps: { type: 'integer' },
              vatMinor: minorUnits,
              serviceChargeBps: { type: 'integer' },
              serviceChargeMinor: minorUnits,
              totalDue: minorUnits,
              totalDueVes: minorUnits,
              amountPaidVes: minorUnits,
              remainingVes: minorUnits,
              fxRateVesPerUnit: { type: ['string', 'null'] },
              usdReference: { type: ['string', 'null'] },
              itemCount: { type: 'integer' },
              openedAt: { type: ['string', 'null'], format: 'date-time' },
              openMinutes: {
                type: ['integer', 'null'],
                description: 'How long this table has been sitting. Computed here rather than by the client: a browser subtracting dates uses the visitor\'s clock, which is how a table reads as opened in the future.'
              },
              pendingClaims: {
                type: 'integer',
                description: 'Diners at this table who say they have paid and nobody has verified. The one per-table fact a floor view cannot derive from the bill, and the one with somebody waiting.'
              },
              tipVes: { ...minorUnits, description: 'Tips already settled on this bill, so a table that tipped well is visible while its diners are still sitting there.' },
              updatedAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    ]
  },

  FloorList: {
    type: 'object',
    properties: { data: { type: 'array', items: ref('FloorTable') } }
  },

  BulkTablesRequest: {
    type: 'object',
    required: ['count'],
    properties: {
      count: { type: 'integer', minimum: 1, maximum: 200, description: 'How many tables the restaurant has.' },
      prefix: {
        type: 'string', maxLength: 20, default: 'Mesa',
        description: 'Joined to the number with a space: "Mesa" gives "Mesa 1", "Mesa 2".'
      }
    }
  },

  BulkTablesResult: {
    type: 'object',
    properties: {
      created: { type: 'integer', description: 'Tables in the range that did not exist at all.' },
      reactivated: {
        type: 'integer',
        description:
          'Tables in the range that existed but had been deleted (deactivated) and were brought back. Counted separately from alreadyExisted because something did change for them.'
      },
      alreadyExisted: { type: 'integer', description: 'Tables in the range that were already there and already active.' },
      data: { type: 'array', items: ref('Table'), description: 'Every active table afterwards.' }
    }
  },

  TableList: {
    type: 'object',
    properties: {
      data: { type: 'array', items: ref('Table') },
      limit: { type: 'integer' },
      offset: { type: 'integer' }
    }
  },

  CreateTableRequest: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 50 } }
  },

  UpdateTableRequest: {
    type: 'object',
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 50 },
      active: { type: 'boolean' }
    }
  },

  MenuCategory: {
    type: 'object',
    description:
      'A section of the menu. Ordered by `position`, which is what makes the section list a menu rather than a set — starters before desserts, an order alphabetical sorting cannot express.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string', maxLength: 80 },
      position: { type: 'integer', description: 'Order on the menu. Set from where the section first appeared in an OCR import, which is the printed order.' },
      active: { type: 'boolean', description: 'False hides the whole section from the public menu without deactivating each product — the kitchen ran out of fish.' },
      productCount: { type: 'integer', description: 'Present only on GET /menu/categories.' }
    }
  },

  MenuCategoryList: {
    type: 'object',
    properties: {
      data: { type: 'array', items: ref('MenuCategory') },
      uncategorisedCount: {
        type: 'integer',
        description: 'Products with no section. They have no category row to appear under, and a screen that groups by section must still show them.'
      }
    }
  },

  Product: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      priceMinorUnits: minorUnits,
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      categoryId: {
        type: ['string', 'null'], format: 'uuid',
        description: 'The section this sits under. Null is uncategorised — a real state, not a missing value.'
      },
      categoryName: { type: ['string', 'null'], description: 'Flattened on so a client can group without a second request.' },
      position: { type: 'integer', description: 'Order within its section.' },
      active: { type: 'boolean' },
      taxCategory: {
        type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'],
        description: 'Tax treatment of the product. The three non-taxable values all yield zero IVA and are not interchangeable: EXEMPT is exempt by the VAT law itself, EXONERATED by an executive act that expires, and NON_TAXABLE is outside the tax\'s scope. A sales ledger declares them separately.'
      },
      vatBps: {
        type: ['integer', 'null'], minimum: 0, maximum: 10000,
        description: 'The product\'s own IVA rate in basis points, or null when it follows the restaurant\'s general rate — which is the normal case. Null is not a missing value: a dish with no rate of its own is not a dish somebody forgot to set. Only a TAXABLE product may carry one.'
      },
      imageUrl: {
        type: ['string', 'null'],
        description:
          'Path to the dish photo, or null when the restaurant has not uploaded one \u2014 null is the common case and has to keep looking deliberate. Carries a `v=` suffix from the file\u2019s checksum, so a replaced photo is a new address and a phone stops showing the old dish. Use it as given; do not assemble it.',
        examples: ['/api/v1/menu/public/9f1c.../products/2b7e.../image?v=c414cd0e204de974']
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  // What a guest scanning a QR is shown: what a thing is and what it costs.
  // Inactive products are not listed, so `active` would always be true, and
  // edit timestamps are operational detail no diner needs.
  BrandingImage: {
    type: 'object',
    description: "One of the restaurant's two images, described rather than sent.",
    properties: {
      kind: { type: 'string', enum: ['COVER', 'LOGO'] },
      contentType: { type: 'string' },
      sizeBytes: { type: 'integer' },
      url: { type: 'string', description: 'Where a diner fetches it. Use as given; the suffix changes when the image does.' }
    }
  },

  PublicProduct: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      priceMinorUnits: minorUnits,
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      categoryId: {
        type: ['string', 'null'], format: 'uuid',
        description: 'The section this sits under. Null is uncategorised — a real state, not a missing value.'
      },
      categoryName: { type: ['string', 'null'], description: 'Flattened on so a client can group without a second request.' },
      imageUrl: {
        type: ['string', 'null'],
        description:
          'Path to the dish photo, or null when the restaurant has not uploaded one \u2014 null is the common case and has to keep looking deliberate. Carries a `v=` suffix from the file\u2019s checksum, so a replaced photo is a new address and a phone stops showing the old dish. Use it as given; do not assemble it.',
        examples: ['/api/v1/menu/public/9f1c.../products/2b7e.../image?v=c414cd0e204de974']
      }
    }
  },

  ProductList: {
    type: 'object',
    properties: {
      data: { type: 'array', items: ref('Product') },
      limit: { type: 'integer' },
      offset: { type: 'integer' }
    }
  },

  CreateProductRequest: {
    type: 'object',
    required: ['name', 'priceMinorUnits'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 },
      description: { type: ['string', 'null'], maxLength: 500 },
      priceMinorUnits: minorUnits,
      categoryId: { type: ['string', 'null'], format: 'uuid', description: 'The section it belongs under. Null or omitted is uncategorised.' },
      active: { type: 'boolean', default: true },
      taxCategory: {
        type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'], default: 'TAXABLE',
        description: 'Tax treatment of the product. The three non-taxable values all yield zero IVA and are not interchangeable: EXEMPT is exempt by the VAT law itself, EXONERATED by an executive act that expires, and NON_TAXABLE is outside the tax\'s scope. A sales ledger declares them separately.'
      },
      vatBps: {
        type: ['integer', 'null'], minimum: 0, maximum: 10000,
        description: 'Overrides the restaurant\'s general rate for this product. Omit or send null to follow it. Rejected with 400 alongside a non-TAXABLE taxCategory: an exempt product with a 16% stored next to it is a contradiction.'
      }
    },
    description: 'The currency is taken from the restaurant menu currency and is not accepted here.'
  },

  UpdateProductRequest: {
    type: 'object',
    minProperties: 1,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 160 },
      description: { type: ['string', 'null'], maxLength: 500 },
      priceMinorUnits: minorUnits,
      categoryId: {
        type: ['string', 'null'], format: 'uuid',
        description: 'Explicit null moves the product out of every section. Omitting the field leaves it where it is — the two are different.'
      },
      active: { type: 'boolean' },
      taxCategory: {
        type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'],
        description: 'Tax treatment of the product. The three non-taxable values all yield zero IVA and are not interchangeable: EXEMPT is exempt by the VAT law itself, EXONERATED by an executive act that expires, and NON_TAXABLE is outside the tax\'s scope. A sales ledger declares them separately. Moving a product to a non-taxable category clears any vatBps it had: that is what the change means.'
      },
      vatBps: {
        type: ['integer', 'null'], minimum: 0, maximum: 10000,
        description: 'Explicit null returns the product to the restaurant\'s general rate; omitting the field leaves it as it is — the two are different. Sending a rate for a product whose stored category is not TAXABLE is refused with 409 PRODUCT_TAX_CONFLICT.'
      }
    }
  },

  QrContext: {
    type: 'object',
    description:
      'Enough to orient a diner and to fetch the public menu. No amounts: this is unauthenticated and reachable by anyone who can photograph a table.',
    properties: {
      restaurant: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid', description: 'Addresses the public menu.' },
          name: { type: 'string' },
          menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
          coverUrl: {
            type: ['string', 'null'],
            description: "The restaurant's cover photo, or null when it has not uploaded one \u2014 null is the common case and should look deliberate rather than broken. Carries a `v=` suffix from the file's checksum, so a replaced image is a new address. Use as given."
          },
          logoUrl: { type: ['string', 'null'], description: 'The logo, on the same terms as `coverUrl`.' }
        }
      },
      table: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', description: 'What is printed on the table, e.g. "Mesa 6".' }
        }
      },
      hasOpenBill: {
        type: 'boolean',
        description: 'Whether to offer the bill. False means a session would find nothing to show.'
      }
    }
  },

  MenuDocument: {
    type: 'object',
    description:
      'The menu the restaurant uploaded, described rather than sent. No bytes: the file has its own route, and a DTO that could serialise 20 MB into a JSON body eventually would.',
    properties: {
      filename: { type: 'string', description: 'The restaurant\'s own name for the file. Basename only.' },
      contentType: { type: 'string', example: 'application/pdf' },
      sizeBytes: { type: 'integer', description: 'Kept in step with the bytes by a CHECK, so a listing can report it without reading the file.' },
      updatedAt: { type: 'string', format: 'date-time' },
      url: { type: 'string', description: 'The public path the file is served from. Given rather than assembled, so a client cannot build it subtly wrong.' }
    }
  },

  PublicMenu: {
    type: 'object',
    properties: {
      restaurant: ref('MenuSettings'),
      rate: {
        type: ['object', 'null'],
        description: 'The BCV rate in force for the menu currency, so a diner can see the bolívar equivalent of a dollar price. A reference only: a bill is charged at the rate snapshotted when it opens. Null for a menu priced in VES, or when no rate is available — the menu is served either way.',
        properties: {
          currency: { type: 'string', enum: ['USD', 'EUR'] },
          rate: { type: 'string', pattern: '^\\d+\\.\\d{8}$', description: 'Bolívares per unit of `currency`, padded to 8 decimals.' },
          valueDate: { type: ['string', 'null'], format: 'date' }
        }
      },
      menuPdf: {
        allOf: [ref('MenuDocument')],
        nullable: true,
        description: 'The uploaded menu, or null. Lets a client decide between embedding and linking, and gives a menu that is only a PDF something to show when `products` is empty.'
      },
      categories: {
        type: 'array', items: ref('MenuCategory'),
        description: 'Active sections in order. Sent alongside the products rather than nested, so a client renders the headers in the menu\'s order instead of inferring it from whichever products came back.'
      },
      products: { type: 'array', items: ref('PublicProduct') }
    }
  },

  MenuSettings: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      coverUrl: {
        type: ['string', 'null'],
        description: "The restaurant's cover photo, or null when it has not uploaded one \u2014 null is the common case and should look deliberate rather than broken. Carries a `v=` suffix from the file's checksum, so a replaced image is a new address. Use as given."
      },
      logoUrl: { type: ['string', 'null'], description: 'The logo, on the same terms as `coverUrl`.' }
    }
  },

  MenuCharges: {
    type: 'object',
    description: 'Restaurant settings including the charge rates, as basis points.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      vatBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'IVA. 1600 = 16%.' },
      serviceChargeBps: { type: 'integer', minimum: 0, maximum: 10000, description: 'Servicio. 1000 = 10%.' }
    }
  },

  MenuChargesRequest: {
    type: 'object',
    minProperties: 1,
    description: 'At least one rate. Basis points, so no float touches a rate.',
    properties: {
      vatBps: { type: 'integer', minimum: 0, maximum: 10000 },
      serviceChargeBps: { type: 'integer', minimum: 0, maximum: 10000 }
    }
  },

  MenuChargesResult: {
    allOf: [
      ref('MenuCharges'),
      {
        type: 'object',
        properties: {
          openBillsUnaffected: {
            type: 'integer',
            description: 'Bills already open, which keep the rates they opened with.'
          }
        }
      }
    ]
  },

  MenuCurrencyRequest: {
    type: 'object',
    required: ['currency'],
    properties: { currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] } }
  },

  MfaChallenge: {
    type: 'object',
    description: 'What `/auth/login` returns instead of a session when the account has a second factor.',
    required: ['mfaRequired', 'challenge'],
    properties: {
      mfaRequired: { type: 'boolean', const: true, description: 'Branch on this, not on the absence of a token.' },
      challenge: {
        type: 'string',
        description: 'Spend it at `/auth/login/mfa`. It names the account and nothing else — no role, no restaurant — and is not usable as an access token.'
      },
      expiresIn: { type: 'integer', description: 'Seconds. Long enough to read six digits, short enough that a captured challenge is worthless by the time it is replayed.' }
    }
  },

  MfaChallengeRequest: {
    type: 'object',
    required: ['challenge', 'code'],
    properties: {
      challenge: { type: 'string', description: 'From the `/auth/login` response.' },
      code: {
        type: 'string', minLength: 6, maxLength: 32,
        description: 'A six-digit TOTP code, or a recovery code. One field for both on purpose: the server must not behave differently for the two.'
      }
    }
  },

  MfaCodeRequest: {
    type: 'object',
    required: ['code'],
    properties: {
      code: { type: 'string', minLength: 6, maxLength: 32, description: 'A TOTP code or a recovery code.' }
    }
  },

  MfaStatus: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      enabledAt: { type: ['string', 'null'], format: 'date-time' },
      recoveryCodesRemaining: { type: 'integer', description: 'Unspent codes. A client should prompt to regenerate as this approaches zero.' }
    }
  },

  MfaEnrolment: {
    type: 'object',
    description: 'A secret that is stored but not yet in force.',
    properties: {
      secret: { type: 'string', description: 'Base32, for a user typing it in by hand.' },
      otpauthUri: { type: 'string', description: 'Render as a QR code. Carries SHA1/6 digits/30s, which is what every authenticator app assumes.' }
    }
  },

  MfaRecoveryCodes: {
    type: 'object',
    properties: {
      recoveryCodes: {
        type: 'array',
        items: { type: 'string' },
        description: 'The only time these are readable — they are stored hashed. Each is spendable once, in place of a TOTP code.'
      }
    }
  },

  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 1, maxLength: 128 }
    }
  },

  RefreshRequest: {
    type: 'object',
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', minLength: 20, maxLength: 4096 } }
  },

  Session: {
    type: 'object',
    properties: {
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
      expiresIn: { type: 'string' },
      user: ref('SessionUser')
    }
  },

  SessionUser: {
    type: 'object',
    description: 'The authenticated staff member. Returned by login, refresh and /auth/me alike, so a client stores one type.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string' },
      role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] },
      restaurantId: { type: 'string', format: 'uuid' },
      displayName: {
        type: 'string',
        nullable: true,
        maxLength: 80,
        description: [
          'How this person is called, when they have said. Null when they have not, which is',
          'every account until somebody fills it in -- the field is optional and nothing depends',
          'on it. A client with nothing here should fall back to the email rather than invent a name.'
        ].join(' ')
      }
    }
  },

  DisplayNameRequest: {
    type: 'object',
    required: ['displayName'],
    properties: {
      displayName: {
        type: 'string',
        maxLength: 80,
        description: 'Trimmed before storing. The empty string clears the name rather than storing a blank one.'
      }
    }
  },

  GuestSessionRequest: {
    type: 'object',
    required: ['qrToken'],
    properties: { qrToken: { type: 'string', minLength: 20, maxLength: 4096 } }
  },

  GuestSession: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', format: 'uuid' },
      guestToken: {
        type: 'string',
        description: 'Returned once. Only a SHA-256 of it is stored, so it cannot be recovered later.'
      },
      restaurantId: { type: 'string', format: 'uuid' },
      tableId: { type: 'string', format: 'uuid' },
      expiresIn: { type: 'integer' }
    }
  },

  QrToken: {
    type: 'object',
    properties: {
      token: {
        type: 'string',
        description:
          'Signed, and readable: it names its restaurant and table in plain base64url. It is useful only because it is signed, not because it is opaque.'
      },
      expiresIn: {
        type: ['integer', 'null'],
        description:
          'Null by default, meaning the code never expires — it is printed onto a table. Rotating the table nonce is what revokes one. A positive value appears only where QR_TTL_SECONDS is set.'
      }
    }
  },

  ExchangeRate: {
    type: 'object',
    properties: {
      rates: {
        type: 'object',
        description: 'VES per unit of each supported currency. BCV publishes USD and EUR together.',
        additionalProperties: {
          type: 'object',
          properties: {
            rate: {
              type: 'string',
              pattern: '^\\d+\\.\\d{8}$',
              description: 'VES per unit, padded to 8 decimal places.',
              examples: ['757.54060000']
            },
            valueDate: {
              type: ['string', 'null'],
              format: 'date',
              description:
                'The day the rate applies to, from BCV Fecha Valor. BCV publishes around 16:30 Caracas for the next business day, so this is not the fetch date.'
            },
            source: { type: 'string', examples: ['BCV'] },
            fetchedAt: { type: ['string', 'null'], format: 'date-time' }
          }
        }
      }
    }
  },

  Liveness: {
    type: 'object',
    properties: { status: { type: 'string', const: 'ok' } }
  },

  Readiness: {
    type: 'object',
    description: [
      'El código de estado es la respuesta: 200 listo, 503 no listo o drenando.',
      '',
      '`postgres` y `redis` sólo aparecen cuando `HEALTH_DETAIL` está activo, que por',
      'defecto es en desarrollo y no en producción. El endpoint no pide credenciales y',
      'el dominio es público: decir qué dependencia se cayó es contarle a cualquiera qué',
      'se rompió y cuándo reintentar. Un consumidor debe mirar el código, no el cuerpo.'
    ].join('\n'),
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['ready', 'not_ready', 'shutting_down'] },
      postgres: { type: 'string', enum: ['up', 'down'] },
      redis: { type: 'string', enum: ['up', 'down'] }
    }
  }
};

const SignupProfile = {
  type: 'object',
  description:
    'What the restaurant says about itself. Every field is optional — a required qualifying question is one people type "n/a" into, which looks like an answer and is not. Nothing operational reads this.',
  properties: {
    tableCount: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many tables the dining room has.' },
    staffCount: { type: 'integer', minimum: 1, maximum: 2000 },
    posSystem: {
      type: 'string', maxLength: 120,
      description: 'Whatever they run today — a POS name, "Excel", "cuaderno". Free text on purpose: an enum would only list the systems we already thought of.'
    },
    monthlyCovers: { type: 'integer', minimum: 0, maximum: 1000000 },
    notes: { type: 'string', maxLength: 2000, description: 'The free box.' }
  }
};

const onboardingSchemas = {
  SignupProfile,

  SignupRequest: {
    type: 'object',
    required: ['restaurantName', 'rif', 'email', 'phone'],
    properties: {
      restaurantName: { type: 'string', minLength: 2, maxLength: 120 },
      rif: {
        type: 'string',
        description:
          'Venezuelan tax id. Accepted in any spelling — `J-12345678-9`, `j123456789` — and normalised to letter + 9 digits before it is stored or compared. The mod-11 check digit is computed and recorded but **not** enforced: turning away a real restaurant at the registration form is a worse failure than storing one malformed tax id.',
        examples: ['J-12345678-4']
      },
      email: { type: 'string', format: 'email', maxLength: 254, description: "The owner's address. No password is collected here." },
      phone: {
        type: 'string', minLength: 7, maxLength: 40,
        description:
          'Required: the next thing that happens to this submission is that somebody telephones it. Validated loosely on purpose — `+58 412 1234567`, `0412-1234567` and `04121234567` are the same line written by different people, and rejecting two of those spellings loses the restaurant rather than teaching it ours.',
        examples: ['+58 412 1234567']
      },
      menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'], default: 'VES' },
      profile: ref('SignupProfile')
    }
  },

  SignupAccepted: {
    type: 'object',
    description:
      'Identical whether or not the address was already registered. Anything else would make this endpoint an account-enumeration oracle, which is the exact thing /auth/login goes to the trouble of a decoy password hash to avoid.',
    properties: {
      status: { type: 'string', enum: ['RECEIVED'] },
      email: { type: 'string', format: 'email' }
    }
  },

  VerifyRequest: {
    type: 'object',
    required: ['token', 'password'],
    properties: {
      token: { type: 'string', description: 'From the emailed link. Single use, and expires.' },
      password: {
        type: 'string', minLength: 12, maxLength: 128,
        description: 'Set here rather than at signup, so no credential is stored against an unverified address and the public endpoint never runs Argon2id.'
      }
    }
  },

  Plan: {
    type: 'object',
    description: 'What the restaurant is paying for. Nothing is refused when a trial lapses — see GET /api/v1/account.',
    properties: {
      tier: { type: 'string', enum: ['TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'] },
      trialEndsAt: { type: ['string', 'null'], format: 'date-time' },
      trialDaysRemaining: {
        type: ['integer', 'null'],
        description: 'Computed server-side, and negative once past. A browser doing this subtraction uses the visitor\'s clock and timezone, which reads as expired a day early for anyone whose laptop is set wrong.'
      },
      capabilities: {
        type: 'object',
        description: 'What this tier is sold as including, as one boolean per capability. Read it instead of hard-coding the pricing table in the client: a button that answers 403 is a worse experience than a button that is not offered, and a copy of this table on the frontend is the same table maintained twice. Every capability is always present, true or false, so a client can ask about one it does not yet know how to use without treating absence as denial. A false means \'not sold with this plan\', which is not always the same as \'the API will refuse it\' — several capabilities shipped before this table existed and are still served on every tier, because taking them away mid-service is a pricing decision rather than a wiring one. Today only fiscalInvoicing actually refuses, with 403 PLAN_UPGRADE_REQUIRED.',
        additionalProperties: { type: 'boolean' },
        properties: {
          bills: { type: 'boolean' },
          splitting: { type: 'boolean' },
          declaredMobilePayment: { type: 'boolean' },
          c2pCharge: { type: 'boolean' },
          guestOrdering: { type: 'boolean' },
          tipReports: { type: 'boolean' },
          menuOcr: { type: 'boolean' },
          mfa: { type: 'boolean' },
          fiscalInvoicing: { type: 'boolean' }
        }
      }
    }
  },

  Account: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      rif: { type: ['string', 'null'], description: 'Null for restaurants that predate self-service registration.' },
      fiscalAddress: {
        type: ['string', 'null'],
        description: "The premises' address as printed in the receipt header. Null when none has been registered — the receipt omits the line rather than showing a gap, and never invents one."
      },
      contactEmail: {
        type: ['string', 'null'], format: 'email',
        description: 'Where a customer\'s reply to their invoice goes: it is the Reply-To of every invoice email, which is otherwise sent from a no-reply address. Null means no Reply-To, and the email says to ask the restaurant instead. Deliberately not the owner\'s login email, which would otherwise be handed to every customer.'
      },
      menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      vatBps: { type: 'integer' },
      serviceChargeBps: { type: 'integer' },
      payout: { oneOf: [ref('Payout'), { type: 'null' }] },
      plan: ref('Plan'),
      fiscalInvoicePolicy: {
        type: 'string', enum: ['PER_DINER', 'SINGLE_BILL'],
        description: 'Who gets the fiscal invoice. PER_DINER issues one per diner who pays, which is what somebody claiming their own dinner as an expense needs. SINGLE_BILL issues one document for the whole bill and derives each diner\'s breakdown from it -- those breakdowns are not fiscal documents. Both are legitimate and it is the restaurant\'s call, so it is a setting rather than a rule. Only an OWNER may change it: it decides how the restaurant declares.'
      },
      createdAt: { type: 'string', format: 'date-time' }
    }
  }
};

Object.assign(schemas, onboardingSchemas);

Object.assign(schemas, {
  PaymentClaim: {
    type: 'object',
    description:
      'A payment a diner says they made. It settles nothing on its own: `bills.amountPaidVes` is untouched while the claim is PENDING, because money Splite cannot see arrive is not money that has arrived.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      billId: { type: 'string', format: 'uuid' },
      amountVes: minorUnits,
      tipVes: { ...minorUnits, description: 'The voluntary tip declared with this payment. Settles nothing on the bill.' },
      totalPaidVes: { ...minorUnits, description: '`amountVes + tipVes` — the figure to look for in the bank app.' },
      status: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'] },
      paymentMethod: { type: 'string', enum: ['PAGO_MOVIL'] },
      declaredReference: {
        type: ['string', 'null'],
        description: 'Normalised to digits. What the payer transcribed from their bank, and what staff will look for in the bank app.'
      },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  MyTips: {
    type: 'object',
    properties: {
      from: { type: 'string', format: 'date-time' },
      to: { type: 'string', format: 'date-time' },
      currency: { type: 'string', enum: ['VES'] },
      userId: { type: 'string', format: 'uuid' },
      tipsVes: minorUnits,
      billedVes: { ...minorUnits, description: 'What was billed on the payments these tips came with — the denominator of the rate.' },
      tipRateBps: {
        type: ['integer', 'null'],
        description: 'Tips as basis points of what was billed: 840 is 8.40%. Null when nothing was billed — zero would read as "nobody tipped", which is a different fact. Basis points rather than a float for the reason IVA is: a rate that is really 8.399999 is a number somebody argues with.'
      },
      payments: { type: 'integer' },
      bills: { type: 'integer' }
    }
  },

  // Un cubo del desglose de ventas. Compartido por los tres para que no puedan
  // divergir en forma según cuál se lea.
  GuestOrder: {
    type: 'object',
    description:
      'One order a diner sent from their own phone. The lines are already on the bill — this row exists so the floor can be told it happened, and can mark that they have seen it.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tableId: { type: 'string', format: 'uuid' },
      tableName: { type: 'string' },
      billId: { type: ['string', 'null'], format: 'uuid', description: 'The bill the lines landed on. Null once that bill has been purged; the order is history of the room either way.' },
      servedBy: {
        type: ['string', 'null'], format: 'uuid',
        description: 'Who the bill is attributed to, which for a QR order is usually **nobody**: the diner opened it, so no member of staff did. Carried here so the tray can offer "I am taking this table" only where it is actually missing, and never the email in its place — what to show meanwhile is the client\'s decision.'
      },
      lineCount: { type: 'integer', description: 'How many lines were ordered. Compare with `items`: a line a waiter has since removed is gone from `items` but the order still had it.' },
      note: { type: ['string', 'null'], description: 'What the diner wrote with the order, or null. Diner text: render it as text, never as markup.' },
      currency: { type: ['string', 'null'], enum: ['VES', 'USD', 'EUR', null], description: 'The currency of `items[].subtotalMinor`: the bill\'s. A dollar menu leaves its lines in dollars. Null once the bill has been purged.' },
      items: {
        type: 'array',
        description: 'What is still on the bill from this order, oldest first.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The name as it was when ordered, not today\'s menu.' },
            quantity: { type: 'integer' },
            subtotalMinor: minorUnits
          }
        }
      },
      createdAt: { type: 'string', format: 'date-time' },
      ageSeconds: {
        type: ['integer', 'null'],
        description: 'How long this order has been waiting to be seen, computed server-side for the same reason the claims queue does it: a skewed client clock turns a one-minute-old order into a day-old one.'
      }
    }
  },

  GuestOrdersSummary: {
    type: 'object',
    description: 'The queue as numbers, for a badge. Same contract shape and same polling advice as `ClaimsSummary`.',
    properties: {
      pending: { type: 'integer', description: 'Orders nobody on the floor has marked as seen.' },
      oldestPendingAt: { type: ['string', 'null'], format: 'date-time' },
      oldestPendingAgeSeconds: { type: ['integer', 'null'] }
    }
  },

  TakingsChannel: {
    type: 'object',
    properties: {
      paymentsVes: { ...minorUnits, description: 'Settled money that arrived this way.' },
      payments: { type: 'integer', description: 'How many payments that was.' }
    }
  },

  BillAdjustment: {
    type: 'object',
    description:
      'What was written off when a bill was settled short. Never signed: the direction is in `reason`, and a figure that may be negative is a subtraction somebody eventually does twice.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      amountVes: minorUnits,
      reason: {
        type: 'string',
        enum: ['DISCOUNT', 'COMP', 'WRITE_OFF'],
        description: 'A negotiated reduction, the house\'s own courtesy, or money that will not be collected. Three different questions for an owner: a shift full of WRITE_OFF is a problem, one full of COMP is a policy.'
      },
      note: { type: ['string', 'null'], maxLength: 280 },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  ServiceSnapshot: {
    type: 'object',
    description: 'The room right now, plus what has been taken over a window. Every money figure is summed server-side.',
    properties: {
      asOf: { type: 'string', format: 'date-time', description: 'Pass this back as `since` to /activity.' },
      since: { type: ['string', 'null'], format: 'date-time', description: 'The window the `taken` figures cover. Null means the default — today in America/Caracas.' },
      tables: {
        type: 'object',
        properties: {
          total: { type: 'integer' }, occupied: { type: 'integer' }, free: { type: 'integer' }
        }
      },
      openBills: {
        type: 'object',
        properties: {
          count: { type: 'integer' },
          totalDueVes: minorUnits,
          amountPaidVes: minorUnits,
          outstandingVes: { ...minorUnits, description: 'What the room still owes. Due minus paid, computed here so no client subtracts two strings.' },
          oldestOpenedAt: { type: ['string', 'null'], format: 'date-time' }
        }
      },
      taken: {
        type: 'object',
        description: 'Settled money in the window, read from the transition to SUCCEEDED rather than from when the row was created — a declared payment settles when staff verify it, not when the diner says so.',
        properties: {
          paymentsVes: minorUnits, tipsVes: minorUnits, payments: { type: 'integer' },
          byChannel: {
            type: 'object',
            description: 'How the money arrived — not the same question as where it now sits, which the tips report answers. `app` is what diners paid themselves (C2P, Pago Móvil); `till` is what a staff member recorded (cash, card, transfer); `unclassified` is `SPLITE` and `OTHER`, which name no channel and are reported as what they are rather than guessed into one. The three sum to the totals above.',
            properties: {
              app: { $ref: '#/components/schemas/TakingsChannel' },
              till: { $ref: '#/components/schemas/TakingsChannel' },
              unclassified: { $ref: '#/components/schemas/TakingsChannel' }
            }
          }
        }
      },
      adjustments: {
        type: 'object',
        description:
          'What was **not** collected, because bills were settled short over the same window. The counterpart of `taken`, and never part of it: this money never arrived. Without it, forgiving fifty thousand bolívares in a shift shows up on no screen at all — the only trace is the audit log, which nobody opens while counting the till.',
        properties: {
          totalVes: minorUnits,
          bills: { type: 'integer', description: 'How many bills were settled short.' },
          discountVes: minorUnits,
          compVes: minorUnits,
          writeOffVes: minorUnits
        }
      },
      claims: {
        type: 'object',
        description: 'Declared Pago Móvil waiting for a person. The age is the half that matters: a count cannot tell a quiet queue from an ignored one.',
        properties: {
          pending: { type: 'integer' },
          oldestPendingAt: { type: ['string', 'null'], format: 'date-time' },
          oldestPendingAgeSeconds: { type: ['integer', 'null'] }
        }
      },
      unresolvedC2P: {
        type: 'object',
        description: 'Charges where the diner has been debited and only a person can end it.',
        properties: { inDoubt: { type: 'integer' }, ambiguous: { type: 'integer' } }
      }
    }
  },

  PaymentActivity: {
    type: 'object',
    properties: {
      asOf: { type: 'string', format: 'date-time', description: 'The next cursor. Returned even when nothing happened, so a poll advances instead of re-scanning the same window forever.' },
      since: { type: ['string', 'null'], format: 'date-time' },
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['SETTLED', 'DECLARED'] },
            at: { type: 'string', format: 'date-time' },
            paymentId: { type: 'string', format: 'uuid' },
            billId: { type: 'string', format: 'uuid' },
            tableId: { type: ['string', 'null'], format: 'uuid' },
            tableName: { type: ['string', 'null'], description: 'What a person reads. Nobody recognises a uuid across a dining room.' },
            amountVes: minorUnits,
            tipVes: minorUnits,
            paymentMethod: { type: 'string' }
          }
        }
      }
    }
  },

  PaymentDetails: {
    type: 'object',
    description: 'Where restaurants pay Splite. Shown to them on purpose; nothing here is secret.',
    properties: {
      holder: { type: ['string', 'null'] },
      idNumber: { type: ['string', 'null'], description: 'RIF or cédula.' },
      bankName: { type: ['string', 'null'] },
      bankCode: { type: ['string', 'null'], pattern: '^\\d{4}$' },
      phone: { type: ['string', 'null'], description: 'Pago Móvil number.' },
      accountNumber: { type: ['string', 'null'] },
      zelle: { type: ['string', 'null'] },
      notes: { type: ['string', 'null'] }
    }
  },

  SubscriptionNotice: {
    type: 'object',
    description: 'A restaurant saying it paid Splite. Not a payment until someone at Splite confirms it.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      restaurantId: { type: 'string', format: 'uuid' },
      restaurantName: { type: 'string' },
      chargeId: { type: ['string', 'null'], format: 'uuid' },
      chargePeriodStart: { type: ['string', 'null'], format: 'date' },
      method: { type: 'string', enum: ['PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER'] },
      currency: { type: 'string', enum: ['VES', 'USD'] },
      amount: minorUnits,
      reference: { type: ['string', 'null'] },
      paidOn: { type: 'string', format: 'date' },
      notes: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'REJECTED'] },
      rejectReason: { type: ['string', 'null'] },
      submittedBy: { type: ['string', 'null'] },
      reviewedAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  Lead: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      restaurantName: { type: 'string' },
      rif: { type: ['string', 'null'] },
      email: { type: 'string' },
      phone: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['NEW', 'CONTACTED', 'INVITED', 'ONBOARDED', 'REJECTED'] },
      rifChecksumOk: { type: ['boolean', 'null'] },
      createdAt: { type: 'string', format: 'date-time' },
      invitedAt: { type: ['string', 'null'], format: 'date-time' },
      consumedAt: { type: ['string', 'null'], format: 'date-time' }
    }
  },

  OperatorSession: {
    type: 'object',
    description: 'A console session. Signed with a different key and audience from staff sessions: neither opens the other\'s routes.',
    properties: {
      accessToken: { type: 'string' },
      expiresIn: { type: 'integer', description: 'Seconds. There is no refresh; sign in again.' },
      operator: ref('Operator')
    }
  },

  Operator: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      displayName: { type: 'string' },
      role: { type: 'string', enum: ['ADMIN', 'SUPPORT'] },
      active: { type: 'boolean' },
      activated: { type: 'boolean' },
      lastLoginAt: { type: ['string', 'null'], format: 'date-time' }
    }
  },

  AdminClient: {
    type: 'object',
    description: 'A restaurant as Splite bills it. Amounts are US dollar cents as strings.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      rif: { type: ['string', 'null'] },
      ownerEmail: { type: ['string', 'null'] },
      tier: { type: 'string', enum: ['TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'] },
      trialEndsAt: { type: ['string', 'null'], format: 'date-time' },
      state: { type: 'string', enum: ['TRIAL', 'TRIAL_EXPIRED', 'ACTIVE', 'OVERDUE', 'SUSPENDED', 'CANCELLED'], description: 'One word for the situation. CANCELLED and SUSPENDED win over everything; OVERDUE means an open charge is past its due date.' },
      subscriptionStatus: { type: 'string', enum: ['ACTIVE', 'SUSPENDED', 'CANCELLED'] },
      billingCycle: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] },
      customPriceUsd: { ...minorUnits, type: ['string', 'null'] },
      listPriceUsd: { ...minorUnits, type: ['string', 'null'] },
      priceUsd: { ...minorUnits, type: ['string', 'null'], description: 'What the next charge will be: the agreed price, else the list price. Null on a trial.' },
      monthlyValueUsd: { ...minorUnits, type: ['string', 'null'] },
      balanceUsd: minorUnits,
      lastActivityAt: { type: ['string', 'null'], format: 'date-time', description: 'When the restaurant last opened a bill.' },
      createdAt: { type: 'string', format: 'date-time' },
      notes: { type: ['string', 'null'] }
    }
  },

  AdminCharge: {
    type: 'object',
    description: 'What a restaurant owes Splite for one period. **Not a fiscal invoice.**',
    properties: {
      id: { type: 'string', format: 'uuid' },
      restaurantId: { type: 'string', format: 'uuid' },
      restaurantName: { type: 'string' },
      tier: { type: 'string' },
      billingCycle: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] },
      periodStart: { type: 'string', format: 'date' },
      periodEnd: { type: 'string', format: 'date' },
      amountUsd: minorUnits,
      paidUsd: minorUnits,
      remainingUsd: minorUnits,
      dueOn: { type: 'string', format: 'date' },
      status: { type: 'string', enum: ['OPEN', 'PAID', 'VOID'] },
      overdue: { type: 'boolean' },
      paidAt: { type: ['string', 'null'], format: 'date-time' },
      voidReason: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  AdminPayment: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      restaurantId: { type: 'string', format: 'uuid' },
      chargeId: { type: ['string', 'null'], format: 'uuid' },
      method: { type: 'string', enum: ['PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER'] },
      currency: { type: 'string', enum: ['VES', 'USD'] },
      amount: minorUnits,
      fxRate: { type: ['string', 'null'], description: 'Bs per US dollar used to apply a VES payment. Fixed when recorded.' },
      appliedUsd: minorUnits,
      reference: { type: ['string', 'null'] },
      receivedOn: { type: 'string', format: 'date' },
      notes: { type: ['string', 'null'] },
      recordedBy: { type: ['string', 'null'] },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  PlanPrice: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      tier: { type: 'string', enum: ['STARTER', 'PRO', 'ENTERPRISE'] },
      billingCycle: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] },
      amountUsd: minorUnits,
      effectiveFrom: { type: 'string', format: 'date' },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  BankConnection: {
    type: 'object',
    description: 'Where a restaurant\'s bank movements come from. Never carries a secret: none is stored, and a webhook\'s signing secret is returned only when the connection is created or its secret rotated.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['WEBHOOK', 'STATEMENT_IMPORT', 'MERCANTIL_P2C'] },
      label: { type: 'string' },
      bankCode: { type: ['string', 'null'], pattern: '^\\d{4}$' },
      autoConfirm: { type: 'boolean', description: 'Whether a MATCHED movement from here confirms a claim with nobody looking. Off by default; OWNER only.' },
      secretVersion: { type: 'integer' },
      columnMap: { type: ['object', 'null'], description: 'For STATEMENT_IMPORT: which column of the statement holds each value (0-based), saved so the next upload does not ask again.' },
      merchantRif: { type: ['string', 'null'], description: 'For MERCANTIL_P2C: the merchant\'s RIF, without dashes or leading zeros.' },
      hasKey: { type: 'boolean', description: 'For MERCANTIL_P2C: whether Mercantil\'s key is stored. The key itself is never returned.' },
      inboundPath: { type: ['string', 'null'], description: 'Where this connection\'s movements arrive: the path to give Mercantil, or the signed webhook\'s path. Null for STATEMENT_IMPORT.' },
      lastMovementAt: { type: ['string', 'null'], format: 'date-time' },
      lastError: { type: ['string', 'null'] },
      lastErrorAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' }
    }
  },

  MercantilNotificationReply: {
    type: 'object',
    description: 'The envelope Mercantil expects back: its own `infoMsg`, echoed, and a code.',
    properties: {
      infoMsg: { type: 'object' },
      code: { type: 'integer' },
      codigo: { type: 'string', enum: ['0000', '9999'] },
      mensajeCliente: { type: 'string' },
      mensajeSistema: { type: 'string' },
      idRegistro: { type: 'string' }
    }
  },

  BankMovementInput: {
    type: 'object',
    description: 'One incoming movement, in whatever format the bank writes it. `amountMinor` (digits, céntimos) takes precedence over `amount` (text: "1.234,56", "1234.56", "Bs 1.234,56"). Debits and anything that cannot be read unambiguously are rejected with a reason rather than guessed.',
    properties: {
      reference: { type: 'string', description: 'Digits are kept, everything else dropped. 4 to 40 digits.' },
      amount: { type: 'string' },
      amountMinor: { type: 'string', pattern: '^\\d{1,15}$' },
      occurredAt: { type: ['string', 'null'], description: 'ISO 8601, DD/MM/YYYY or DD/MM/YYYY HH:mm. Without a zone it is read as Caracas time.' },
      phoneOrigin: { type: ['string', 'null'] },
      idOrigin: { type: ['string', 'null'], description: 'The payer\'s cédula or RIF, as the bank prints it.' },
      bankCode: { type: ['string', 'null'], description: 'The payer\'s bank, four digits.' },
      description: { type: ['string', 'null'] }
    }
  },

  BankIngestResult: {
    type: 'object',
    properties: {
      received: { type: 'integer' },
      inserted: { type: 'integer' },
      duplicates: { type: 'integer', description: 'Already known (same restaurant, reference and amount). Sending the same movement twice is harmless.' },
      rejected: {
        type: 'array',
        items: { type: 'object', properties: { index: { type: 'integer' }, reason: { type: 'string', enum: ['shape', 'reference', 'amount', 'amount_precision', 'debit'] } } }
      },
      matches: {
        type: 'object',
        description: 'The pending Pago Móvil claims, checked again against every recent movement.',
        properties: {
          matched: { type: 'integer' }, mismatch: { type: 'integer' }, ambiguous: { type: 'integer' },
          notFound: { type: 'integer' }, autoConfirmed: { type: 'integer' }
        }
      }
    }
  },

  BankMovement: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      reference: { type: 'string' },
      amountMinor: { type: 'string' },
      occurredAt: { type: ['string', 'null'], format: 'date-time' },
      bankCode: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      receivedAt: { type: 'string', format: 'date-time' },
      matched: { type: 'boolean', description: 'Already backs a confirmed claim.' }
    }
  },

  StaffInvitation: {
    type: 'object',
    description: 'An open invitation to join the team. Never carries the token or its hash: the link is returned once, when the invitation is created, and cannot be read again.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] },
      invitedBy: { type: ['string', 'null'], format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' }
    }
  },

  StaffMember: {
    type: 'object',
    description:
      'Somebody who works at the signed-in restaurant. The same field names as `user` in a login response, so a client keeps one type. There is no field that could carry a password hash, and the service never selects the column.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: ['string', 'null'] },
      displayName: {
        type: ['string', 'null'],
        description: 'What this person calls themselves, set by them under their own account. Null when they have not set one — the client decides what to show instead; the server does not substitute the email.'
      },
      role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] },
      active: { type: 'boolean' },
      restaurantId: { type: 'string', format: 'uuid' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  StaffPaymentClaim: {
    allOf: [
      ref('PaymentClaim'),
      {
        type: 'object',
        description: "The corroborating detail, which goes only to staff — `phoneOrigin` is a diner's personal number and `idOrigin` their identity document. This is what a verifier matches against the movement in the bank app; none of it is proof on its own.",
        properties: {
          phoneOrigin: { type: ['string', 'null'] },
          bankOrigin: { type: ['string', 'null'], description: 'Four-digit bank code. Claims declared before this field was a code may carry free text instead.' },
          bankOriginName: { type: ['string', 'null'], description: 'Resolved from `bankOrigin`, or null when it is not a code we know.' },
          idOrigin: { type: ['string', 'null'], description: "The payer's cédula or RIF, as the receiving bank prints it beside the movement." },
          declaredAt: { type: ['string', 'null'], format: 'date-time' },
          tableName: { type: ['string', 'null'], description: 'The table the bill is on. Filled in the queue (`GET /payments/claims`); null elsewhere.' },
          payerName: { type: ['string', 'null'], description: "The payer's name from their split share or their invoice request, or null when they gave none. Filled in the queue only." },
          bankMatch: {
            type: ['object', 'null'],
            description: 'What the restaurant\'s bank connection says about this claim, the last time it was checked. Null when there is no connection or it was never checked. Queue only.',
            properties: {
              outcome: { type: 'string', enum: ['MATCHED', 'MISMATCH', 'AMBIGUOUS', 'NOT_FOUND'] },
              disagreements: { type: 'array', items: { type: 'string', enum: ['amount', 'bank', 'phone', 'id'] } },
              movementReference: { type: ['string', 'null'] },
              autoConfirmed: { type: 'boolean' },
              checkedAt: { type: ['string', 'null'], format: 'date-time' }
            }
          }
        }
      }
    ]
  },

  DeclareClaimRequest: {
    type: 'object',
    required: ['amountVes', 'reference'],
    properties: {
      amountVes: { ...minorUnits, description: 'VES céntimos. May be part of the bill: splitting is the point.' },
      reference: {
        type: 'string', minLength: 4, maxLength: 32,
        description: 'The reference the payer\'s bank assigned. Required — a claim without one asks staff to find an unidentified transfer among the evening\'s takings. Digits, spaces, dots and dashes; normalised to digits before storage, so one reference cannot claim two bills by being typed differently.'
      },
      phoneOrigin: { type: 'string', description: 'Optional. Not proof, but it is how a movement is found quickly. Must be a Venezuelan mobile line — a Pago Móvil cannot originate anywhere else.' },
      bankOrigin: { type: 'string', pattern: '^[0-9]{4}$', description: "Optional. The payer's bank, as a four-digit code rather than a name, so that two spellings of one bank do not compare as two banks." },
      idOrigin: { type: 'string', description: "Optional, and the strongest of the three: a phone can be borrowed and a bank is shared by millions, but the receiving app prints the payer's document beside the movement. Cédula or RIF, e.g. V12345678." },
      splitParticipantId: { type: 'string', format: 'uuid', description: 'Optional. Attribute this declared payment to a split share, credited when staff confirm it.' },
      tipVes: { ...minorUnits, description: 'Optional voluntary tip, default 0. Part of the same transfer: staff verify `amountVes + tipVes` as one figure against the bank app.' },
      invoice: {
        type: 'object',
        required: ['email'],
        description: [
          'Optional. "Send me the invoice": stored with the claim and fulfilled when a member of staff',
          'confirms it — the first moment a fiscal invoice can exist for this payment. The diner does',
          'not have to wait on the screen; the invoice is issued through the same path as',
          '`POST /guest/bill/invoice` and delivered to `email`.',
          '',
          'It never makes the claim fail. It is stored even where invoicing is unavailable, and if',
          'the invoice cannot be issued at confirmation the request is marked FAILED with its reason',
          '(see `invoiceRequest` on `GET /guest/payments/{id}`); the payment is confirmed regardless.',
          'Offer it only when `canRequestInvoice` on the bill is true.'
        ].join('\n'),
        properties: {
          email: { type: 'string', format: 'email', maxLength: 255, description: 'Where to deliver it. Required: the diner will not be looking at the screen when it is issued.' },
          name: { type: 'string', minLength: 1, maxLength: 160, description: 'Optional. With `taxId`, invoices in the diner\'s name instead of as a final consumer.' },
          taxId: { type: 'string', pattern: '^[VEJGPC][0-9]{6,9}$', description: 'Optional cédula or RIF, e.g. V12345678.' }
        }
      }
    }
  },

  C2PChargeRequest: {
    type: 'object',
    required: ['amountVes', 'bankCode', 'idNumber', 'phone', 'clave', 'idempotencyKey'],
    description:
      'A charge against the diner\'s own bank account. Every field except the amount belongs to the diner\'s relationship with their bank, not with Splite.',
    properties: {
      amountVes: { ...minorUnits, description: 'VES céntimos. May be part of the bill: splitting is the point.' },
      bankCode: {
        type: 'string', pattern: '^[0-9]{4}$',
        description: 'The diner\'s own bank, which is where the debit comes from. Must be a known Venezuelan bank code.'
      },
      idNumber: {
        type: 'string', pattern: '^[VEJGPC][0-9]{6,9}$',
        description: 'Cédula or RIF of the account holder, e.g. V12345678.'
      },
      phone: {
        type: 'string',
        description: 'The mobile line the account is registered to. Must be a Venezuelan mobile prefix (0412, 0414, 0416, 0422, 0424, 0426).'
      },
      clave: {
        type: 'string', pattern: '^[0-9]{4,16}$',
        description:
          'The single-use clave the diner obtained from their own bank. Used once and never stored — there is no column for it, and it is redacted out of every diagnostic. Claves expire, and how fast depends on the bank: some give six hours, at least one gives five minutes.'
      },
      idempotencyKey: {
        type: 'string', minLength: 16, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$',
        description: 'Used when the Idempotency-Key header is absent. Mandatory here: it is what makes a lost connection safe to retry.'
      }
    }
  },

  C2PChargeResult: {
    type: 'object',
    required: ['paymentId', 'status'],
    description: [
      'The outcome of a C2P charge. **All four statuses must be handled**, and the difference',
      'between two of them is the difference between a diner paying once and paying twice.',
      '',
      '- `SUCCEEDED` — settled. `settlement` carries the new bill figures.',
      '- `FAILED` — the bank rejected it. Safe to offer a retry with a fresh clave.',
      '- `IN_DOUBT` — the bank did not answer conclusively. **Do not offer a retry.** The debit',
      '  may have landed; Mercantil does not promise that invoice numbers deduplicate. Staff',
      '  resolve it from `POST /api/v1/payments/c2p/{id}/resolve`.',
      '- `AMBIGUOUS` — the debit is confirmed and could not be credited to the bill, usually',
      '  because the bill closed while the charge was in flight. Needs a person, and a refund.'
    ].join('\n'),
    properties: {
      paymentId: { type: 'string', format: 'uuid', description: 'The ledger row this charge created.' },
      status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'IN_DOUBT', 'AMBIGUOUS'] },
      invoiceNumber: { type: 'string', description: 'Splite\'s correlation id in Mercantil\'s records. Not an idempotency key.' },
      bankReference: { type: ['string', 'null'], description: 'The bank movement that settled it, when there is one.' },
      reason: { type: ['string', 'null'], description: 'Why it failed or needs review. Human-readable; never parse it.' },
      requiresResolution: { type: 'boolean', description: 'Present on IN_DOUBT. The charge is unresolved and must not be retried.' },
      requiresStaffReview: { type: 'boolean', description: 'Present on AMBIGUOUS.' },
      settlement: ref('PaymentResult')
    }
  },

  C2PUnresolvedCharge: {
    type: 'object',
    description: 'A C2P charge waiting on a person or on the settlement window.',
    properties: {
      paymentId: { type: 'string', format: 'uuid' },
      billId: { type: 'string', format: 'uuid' },
      amountVes: minorUnits,
      status: { type: 'string', enum: ['IN_DOUBT', 'AMBIGUOUS'] },
      invoiceNumber: { type: 'string' },
      payerBankCode: { type: 'string', pattern: '^[0-9]{4}$' },
      payerBankName: { type: ['string', 'null'] },
      payerPhoneLast4: {
        type: 'string', pattern: '^[0-9]{4}$',
        description: 'Four digits, which is all that is stored. Enough to tell two simultaneous payers apart in the bank app, and not a phone number.'
      },
      candidateReferences: {
        type: 'array', items: { type: 'string' },
        description: 'Bank movements that matched on amount, including the ones rejected for not identifying the payer. The list to hand a restaurant insisting the money is there.'
      },
      lastReason: { type: ['string', 'null'] },
      lastResolutionAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: ['string', 'null'], format: 'date-time' }
    }
  },

  C2PResolution: {
    type: 'object',
    required: ['paymentId', 'status'],
    description:
      'What asking the bank produced. A charge that settles nothing is a normal outcome here, not an error: closing the wrong bill is worse than closing none.',
    properties: {
      paymentId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['SUCCEEDED', 'FAILED', 'IN_DOUBT', 'AMBIGUOUS'] },
      bankReference: { type: ['string', 'null'], description: 'Set when a movement was matched and spent.' },
      signals: {
        type: 'array', items: { type: 'string' },
        description: 'What identified the payer. Always includes `amount`; a settlement additionally requires `phone_last4`.'
      },
      candidateReferences: {
        type: 'array', items: { type: 'string' },
        description: 'On AMBIGUOUS: the movements that matched on amount and could not be told apart.'
      },
      reason: { type: ['string', 'null'] },
      requiresStaffReview: { type: 'boolean' },
      resolutionPending: {
        type: 'boolean',
        description: 'The settlement window has not passed, so a missing movement proves nothing yet.'
      },
      retryAfterMinutes: { type: 'integer', description: 'How long until asking again is worthwhile.' },
      alreadyResolved: { type: 'boolean', description: 'Something else resolved it first. Not an error.' },
      safeToRetry: {
        type: 'boolean',
        description:
          'Whether raising a fresh charge is safe. True only on FAILED, where the bank was asked about the right period and no debit landed. Explicitly **false** when a charge outlives the six-hour search window: nothing there establishes that the diner was not debited, so it goes to AMBIGUOUS for a person rather than being reported as retryable. Absent means no claim either way — never read absence as true.'
      },
      settlement: ref('PaymentResult')
    }
  },

  C2PBankClave: {
    type: 'object',
    description:
      'How a diner obtains a single-use C2P clave at one bank. Static reference data from the acquirer communication, not per-diner.',
    properties: {
      bankCode: { type: 'string', pattern: '^[0-9]{4}$' },
      bankName: { type: ['string', 'null'] },
      ttlMinutes: {
        type: ['integer', 'null'],
        description: 'How long the clave lives. `null` means until the close of the banking day.'
      },
      ttlLabel: { type: 'string', description: 'Human-readable form of the TTL.' },
      amountBound: {
        type: 'boolean',
        description: 'The clave carries the amount, so it dies if the bill changes. Always fetch it at payment time.'
      },
      strategy: {
        type: ['object', 'null'],
        description: 'When to fetch the clave, derived from the TTL and amountBound.',
        properties: {
          when: { type: 'string', enum: ['anytime', 'at_payment'] },
          reason: { type: 'string' }
        }
      },
      channels: {
        type: 'array',
        description: 'Only the channels this bank actually offers.',
        items: {
          type: 'object',
          properties: {
            channel: { type: 'string', enum: ['APP', 'WEB', 'SMS'] },
            text: { type: 'string', description: 'Ready-to-display instruction.' },
            shortCode: { type: 'string', description: 'SMS only: the short code to text.' },
            smsBody: { type: 'string', description: 'SMS only: the message body.' },
            altShortCode: { type: ['string', 'null'], description: 'SMS only: an alternate short code for a different carrier.' },
            note: { type: ['string', 'null'] }
          }
        }
      }
    }
  },

  Payout: {
    type: 'object',
    description:
      'Where the restaurant is paid. Splite never holds the money — a Pago Móvil goes from the diner\'s account to the restaurant\'s — so this is what a diner needs on screen in order to pay at all.',
    properties: {
      bankCode: { type: 'string', pattern: '^[0-9]{4}$', examples: ['0105'] },
      bankName: { type: ['string', 'null'] },
      chargeable: {
        type: 'boolean',
        description: 'Whether a payment can be raised through this bank in-app, as opposed to the diner being told where to send one. False for every bank today: naming a bank is not a claim that we integrate with it.'
      },
      accountNumber: { type: 'string', pattern: '^[0-9]{20}$' },
      phone: { type: 'string', description: 'Digits only. The number the Pago Móvil is registered to.' },
      holderId: { type: 'string', examples: ['J123456789'], description: 'Cédula or RIF the account is held under. Not assumed from the restaurant RIF — plenty of small places bank on the owner\'s cédula.' }
    }
  },

  GuestPayee: {
    type: 'object',
    description:
      'The same details as a diner needs them. **No account number**: a Pago Móvil is addressed by bank, phone and identity document, and publishing a restaurant\'s account to anyone who scans a sticker should be a decision rather than a side effect of reusing a mapper.',
    properties: {
      bankCode: { type: 'string' },
      bankName: { type: ['string', 'null'] },
      phone: { type: 'string' },
      holderId: { type: 'string' }
    }
  },

  FiscalInvoiceTax: {
    type: 'object',
    description: 'One row per rate. This is what a fiscal document actually declares, and it is kept separate from the lines because an AGGREGATE invoice has a single line and still has to separate the 16% from the exempt part.',
    properties: {
      taxCategory: { type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'] },
      vatBps: { type: 'integer', minimum: 0, maximum: 10000 },
      baseMinor: minorUnits,
      vatMinor: minorUnits
    }
  },

  FiscalInvoiceLine: {
    type: 'object',
    properties: {
      position: { type: 'integer' },
      description: { type: 'string' },
      quantityMilli: {
        type: 'string', pattern: '^[0-9]+$',
        description: 'Quantity in thousandths: 338 is 0.338 of a dish. A prorated line really is a fraction of a plate, and rounding it to a whole would misstate the amount — which is the one thing that cannot move. Sent as an integer string for the same reason money is: a float stops being exact sooner than you would think.'
      },
      unitPriceMinor: minorUnits,
      taxCategory: { type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'] },
      vatBps: { type: 'integer' },
      baseMinor: minorUnits,
      vatMinor: minorUnits
    }
  },

  FiscalInvoice: {
    type: 'object',
    description: 'An issued fiscal document. `documentNumber` and `controlNumber` are assigned by the authorised imprenta digital and returned as given — Splite never generates either.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      billId: { type: 'string', format: 'uuid' },
      paymentId: { type: ['string', 'null'], format: 'uuid' },
      documentType: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'] },
      compensatesId: {
        type: ['string', 'null'], format: 'uuid',
        description: 'Which document this credit note compensates. An issued invoice is never corrected; it is compensated by another document.'
      },
      documentNumber: { type: 'string' },
      controlNumber: { type: 'string' },
      provider: { type: 'string' },
      lineBasis: {
        type: 'string', enum: ['ITEMISED', 'PRORATED', 'AGGREGATE'],
        description: 'How the lines were built. ITEMISED when the split was by product and the payment matched that share, so the real dishes are known. PRORATED scales the bill lines by what was paid. AGGREGATE is one descriptive line. Published so a panel can explain why an invoice reads "0.338 x Hamburguesa" instead of leaving the restaurant guessing.'
      },
      currency: { type: 'string', enum: ['VES'] },
      subtotalMinor: minorUnits,
      vatMinor: minorUnits,
      serviceMinor: minorUnits,
      totalMinor: minorUnits,
      customer: {
        type: ['object', 'null'],
        description: 'Null means consumidor final, which is the majority case and a complete answer rather than a half-filled form.',
        properties: {
          name: { type: ['string', 'null'] },
          taxId: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] }
        }
      },
      issuedAt: { type: 'string', format: 'date-time' },
      tableName: { type: ['string', 'null'], description: 'The table the bill was on. Only in the list (`GET /fiscal/invoices`); null when the table was deleted.' },
      lines: { type: 'array', items: ref('FiscalInvoiceLine'), description: 'Only on a single-invoice read.' },
      taxes: { type: 'array', items: ref('FiscalInvoiceTax'), description: 'Only on a single-invoice read.' },
      delivery: {
        description: 'Only on a single-invoice read. The emailing of this document, and **null when nobody left an address** — the majority case, not a gap. It is deliberately not part of the document: an invoice is valid whether or not the email arrived, and a mail provider outage can never undo or block an issue. Published so the restaurant can answer "it never reached me" from a screen.',
        oneOf: [
          {
            type: 'object',
            properties: {
              email: { type: 'string' },
              status: {
                type: 'string', enum: ['PENDING', 'SENT', 'FAILED'],
                description: 'PENDING: written but not yet out, or an attempt whose process died. SENT: the provider accepted it — not a read receipt, and not proof of delivery to the inbox. FAILED: attempted and refused. PENDING and FAILED are both retried by the scheduled sweep until the attempt cap.'
              },
              attempts: { type: 'integer' },
              sentAt: { type: 'string', format: 'date-time', nullable: true },
              lastError: {
                type: 'string', nullable: true,
                description: 'The last failure reason, truncated. Staff read it to tell a mistyped address from a provider outage.'
              }
            }
          },
          { type: 'null' }
        ]
      }
    }
  },

  FiscalRequest: {
    type: 'object',
    description: 'An attempt to issue, which is not the same thing as an invoice. UNCERTAIN means the provider answered something that does not say whether it issued — nobody may blindly retry one of these.',
    properties: {
      id: { type: 'string', format: 'uuid' },
      billId: { type: 'string', format: 'uuid' },
      paymentId: { type: ['string', 'null'], format: 'uuid' },
      documentType: { type: 'string', enum: ['INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'] },
      status: { type: 'string', enum: ['PENDING', 'SENT', 'ISSUED', 'FAILED', 'UNCERTAIN'] },
      provider: { type: ['string', 'null'] },
      attempts: { type: 'integer' },
      lastErrorCode: { type: ['string', 'null'] },
      lastAttemptAt: { type: ['string', 'null'], format: 'date-time' },
      createdAt: { type: 'string', format: 'date-time' },
      invoiceId: { type: ['string', 'null'], format: 'uuid', description: 'The invoice this attempt produced, if it produced one.' }
    }
  },

  GuestContactRequest: {
    type: 'object',
    required: ['email'],
    description: 'The diner leaving their details, asked for with a concrete reason: so their invoice can reach them.',
    properties: {
      email: { type: 'string', format: 'email', maxLength: 255 },
      name: { type: 'string', minLength: 1, maxLength: 160 },
      marketingConsent: {
        type: 'boolean',
        description: 'Only true when the diner ticked a box that was empty. Giving an email so an invoice can arrive is NOT consent to marketing -- they are two purposes, and this field is what keeps them apart. Omitting it consents to nothing and withdraws nothing. A previous withdrawal is never reactivated by leaving the address again: somebody who unsubscribed and dines again has not said yes a second time.'
      }
    }
  },

  GuestContactResponse: {
    type: 'object',
    properties: {
      email: { type: 'string' },
      marketingConsent: {
        type: 'boolean',
        description: 'What was stored, not what was asked for. If a withdrawal was on file this comes back false, because the diner is entitled to see they are still unsubscribed rather than believe they just signed up.'
      },
      withdrawn: { type: 'boolean' }
    }
  },

  GuestReceipt: {
    type: 'object',
    description: 'A receipt: the whole table\'s bill, and then what this one diner paid towards it. **Not a fiscal invoice** -- no control number, no authorised printer, no use for deducting tax. That is a separate document, asked for separately.\n\nThe `bill` block is derived from the bill alone and is therefore identical on every receipt from that table; only `payment` differs. That is deliberate: four receipts from a table of four must line up and tell the same dinner, otherwise nobody can check that they were charged for what they ordered or that the parts add up to the whole.',
    properties: {
      restaurant: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          rif: { type: 'string', nullable: true },
          address: { type: 'string', nullable: true, description: 'Omitted when the restaurant has not registered one. Never invented.' }
        }
      },
      table: { type: 'object', properties: { name: { type: 'string' } } },
      bill: {
        type: 'object',
        description: 'The same for every diner at this table.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['OPEN', 'CLOSED', 'VOID'] },
          currency: { type: 'string' },
          openedAt: { type: 'string', format: 'date-time' },
          lines: {
            type: 'array',
            description: 'Every line on the table\'s bill, oldest first, with quantity and unit price -- not just the ones this diner claimed.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                name: { type: 'string', description: 'The name snapshotted when the line was added, so renaming a product cannot rewrite a served bill.' },
                quantity: { type: 'integer' },
                unitPriceMinor: minorUnits,
                subtotalMinor: minorUnits,
                taxCategory: { type: 'string', enum: ['TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'] },
                vatBps: { type: 'integer', nullable: true }
              }
            }
          },
          subtotalMinor: minorUnits,
          serviceChargeBps: { type: 'integer' },
          serviceChargeMinor: minorUnits,
          taxes: {
            type: 'array',
            description: 'One row per rate -- a taxable base and its tax -- which is how it is declared and how it reads. Computed by the same code that wrote the bill\'s stored totals, not a second implementation of the same rule.',
            items: {
              type: 'object',
              properties: {
                vatBps: { type: 'integer' },
                baseMinor: minorUnits,
                vatMinor: minorUnits
              }
            }
          },
          vatMinor: minorUnits,
          totalMinor: minorUnits,
          totalVes: { ...minorUnits, description: 'The total in bolívares, which is what is charged, at the rate frozen when the bill opened.' },
          fxRateVesPerUnit: { type: 'string', nullable: true }
        }
      },
      payment: {
        type: 'object',
        description: 'The only part that differs between the diners of one table.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['PENDING', 'IN_DOUBT', 'AMBIGUOUS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED'] },
          method: { type: 'string' },
          reference: { type: 'string', nullable: true },
          amountVes: { ...minorUnits, description: 'What this payment settles of the bill. The tip is never inside it.' },
          tipVes: minorUnits,
          handedOverVes: { ...minorUnits, description: 'amountVes + tipVes: what actually left the payer\'s account, and the figure they will compare against their bank.' },
          declaredAt: { type: 'string', format: 'date-time' },
          invoiced: { type: 'boolean' },
          invoiceId: { type: 'string', format: 'uuid', nullable: true }
        }
      }
    }
  },

  RequestInvoiceRequest: {
    type: 'object',
    required: ['paymentId'],
    description: 'Every recipient field is optional, and a body carrying only `paymentId` is a complete request meaning consumidor final. That is the majority case, not a degraded one: most people do not hand over their cédula for a dinner. Somebody who does usually needs it exact, so `taxId` is validated rather than accepted as free text.',
    properties: {
      paymentId: { type: 'string', format: 'uuid', description: 'A settled payment on the scanning diner\'s own table. The bill comes from the QR session, so there is no field in which to name somebody else\'s.' },
      name: { type: 'string', minLength: 1, maxLength: 160 },
      taxId: { type: 'string', pattern: '^[VEJGPC][0-9]{6,9}$', examples: ['V12345678'] },
      email: { type: 'string', format: 'email', maxLength: 255 }
    }
  },

  RequestInvoiceResponse: {
    type: 'object',
    properties: {
      status: {
        type: 'string', enum: ['ISSUED', 'UNCERTAIN', 'FAILED'],
        description: 'ISSUED comes with 201 and an invoice. UNCERTAIN and FAILED come with 202 and none: no document has been created, and with UNCERTAIN one may yet be, once a person resolves it.'
      },
      requestId: { type: 'string', format: 'uuid' },
      invoice: { oneOf: [ref('FiscalInvoice'), { type: 'null' }] },
      paymentUnaffected: {
        type: 'boolean',
        description: 'Always true, and worth saying out loud: a failure here never means the payment failed. The money is taken and the receipt stands; what may be pending is the fiscal document. A client that renders this as a failed payment is wrong.'
      }
    }
  },

  UpdateAccountRequest: {
    type: 'object',
    minProperties: 1,
    description:
      'A partial update: send only what changes. `name` stopped being required when this body grew past the name, because requiring it would mean resending it to change anything else — which is how a restaurant gets renamed without meaning to.',
    properties: {
      name: {
        type: 'string', minLength: 1, maxLength: 120, examples: ['Casa 72'],
        description: "The restaurant's own name, as a diner reads it on the QR landing page. Trimmed; something has to be left after trimming, so a name cannot be blanked into an empty landing page."
      },
      fiscalInvoicePolicy: {
        type: 'string', enum: ['PER_DINER', 'SINGLE_BILL'],
        description: 'OWNER only — a MANAGER sending this gets 403 FORBIDDEN_ROLE. PER_DINER issues one fiscal invoice per diner who pays; SINGLE_BILL issues one for the whole bill and derives each diner\'s breakdown from it, those breakdowns not being fiscal documents themselves.'
      },
      fiscalAddress: {
        type: 'string', maxLength: 200, examples: ['Av. Francisco de Miranda, Chacao, Caracas'],
        description: 'The address printed in the receipt header. Three states, not two: omitting the field leaves whatever is stored, a non-empty string replaces it, and an empty string clears it — without that last one a mistyped address could never be removed.'
      },
      contactEmail: {
        type: 'string', maxLength: 255, examples: ['facturas@casa72.com'],
        description: 'Where customers reply to their invoice (Reply-To). Must be an email address; lowercased before it is stored. The same three states as `fiscalAddress`: omit to keep, a value to replace, an empty string to clear.'
      }
    }
  },

  FiscalRifRequest: {
    type: 'object',
    required: ['rif'],
    properties: {
      rif: {
        type: 'string', maxLength: 20, example: 'J-12345678-4',
        description: 'Written however the owner types it — punctuation and case are stripped before it is stored and compared. Nothing but the length ceiling is enforced here: whether it is a RIF is one verdict, given by the handler as 400 `FISCAL_RIF_MALFORMED`, so the error does not change with how short the mistake was.'
      }
    }
  },

  FiscalRifResponse: {
    type: 'object',
    required: ['rif', 'checksumOk'],
    properties: {
      rif: { type: 'string', example: 'J-12345678-4', description: 'Formatted for display; stored normalised.' },
      checksumOk: {
        type: 'boolean',
        description: 'Whether the check digit agrees. False does NOT mean the RIF was rejected — it was stored anyway, and the client should say so out loud rather than block.'
      }
    }
  },

  FiscalSeriesRequest: {
    type: 'object',
    required: ['controlPrefix', 'documentPrefix', 'padTo', 'controlFirst'],
    description:
      'The series a SENIAT authorisation grants this taxpayer, transcribed. Not a partial update: a half-filled series cannot number anything, and storing one only moves the failure to the moment somebody is waiting for their invoice. Nothing here validates the authorisation itself — that it matches the paper is the restaurant\'s responsibility.',
    properties: {
      controlPrefix: {
        type: 'string', maxLength: 20, examples: ['00-'],
        description: 'Exactly as the authorisation writes it, empty string included — some carry no prefix, and there the empty string is the right value rather than an unfilled field.'
      },
      documentPrefix: { type: 'string', maxLength: 20, examples: ['F-'] },
      padTo: {
        type: 'integer', minimum: 1, maximum: 20, examples: [8],
        description: 'How many digits the correlative is padded to. Part of the document\'s identity, not cosmetics: 00-000123 and 00-123 are two different documents to anyone looking one up.'
      },
      controlFirst: {
        type: 'integer', minimum: 1, examples: [1],
        description: 'The first authorised control number.'
      },
      controlLast: {
        type: ['integer', 'null'], minimum: 1, examples: [5000],
        description: 'The last authorised control number, or null for no known ceiling. Issuing past it answers 409 FISCAL_RANGE_EXHAUSTED rather than counting on silently, because a number outside the authorised range is not a typo — it is a document nothing covers.'
      },
      authorisationRef: {
        type: 'string', maxLength: 120,
        description: 'The authorisation\'s own reference, so where the range comes from can be shown without digging out the paper.'
      }
    }
  },

  FiscalSeriesResponse: {
    type: 'object',
    required: ['fiscalSeries'],
    properties: {
      fiscalSeries: {
        type: ['object', 'null'],
        description: 'Null when this restaurant has not configured one. That is an answer, not an error: it is what tells a client to render the empty form.',
        required: ['controlPrefix', 'documentPrefix', 'padTo', 'controlFirst', 'controlLast', 'nextControlNumber', 'locked'],
        properties: {
          controlPrefix: { type: 'string' },
          documentPrefix: { type: 'string' },
          padTo: { type: 'integer' },
          controlFirst: { type: 'string', description: 'Decimal string; the range can exceed a safe integer.' },
          controlLast: { type: ['string', 'null'] },
          authorisationRef: { type: ['string', 'null'] },
          nextControlNumber: {
            type: 'string', examples: ['00-00000001'],
            description: 'Formatted, not raw: it is what will be printed on the next invoice, and showing it this way is what lets somebody check the prefix and width against the authorisation before issuing with them rather than after.'
          },
          locked: {
            type: 'boolean',
            description: 'True once the series has numbered a document. From then on controlPrefix, documentPrefix, padTo and controlFirst are frozen, and a PUT changing any of them answers 409 FISCAL_SERIES_LOCKED with the offending field names in details.fields.'
          },
          updatedAt: { type: ['string', 'null'], format: 'date-time' }
        }
      }
    }
  },

  PayoutRequest: {
    type: 'object',
    description:
      'All four fields together, or an empty object to clear. A half-filled payee looks configured on screen and cannot receive money, and that failure lands on a diner holding a phone rather than on whoever filled the form in.',
    properties: {
      bankCode: { type: 'string', pattern: '^[0-9]{4}$' },
      accountNumber: {
        type: 'string', pattern: '^[0-9]{20}$',
        description: 'Must begin with its own bank code — a Venezuelan account number carries it — so the two fields are checked against each other. Catches the right account entered under the wrong bank.'
      },
      phone: { type: 'string', description: 'Written any way; stored as digits.' },
      holderId: { type: 'string', pattern: '^[VEJPG][0-9]{6,9}$' }
    }
  },

  PaymentProviderConfig: {
    type: 'object',
    description:
      'A stored bank credential set, as anything outside the adapter may see it. **No field here can carry a secret** — `configured` is a boolean because the alternative, a masked tail like `sk_live_••••4821`, is a leak with a decoration on it, and the four characters shown are the four an attacker needed to confirm a guess. There is no read endpoint for the credentials themselves.',
    properties: {
      provider: { type: 'string', examples: ['MERCANTIL'] },
      configured: { type: 'boolean' },
      enabled: {
        type: 'boolean',
        description: 'Whether the rail is live. Storing credentials does not switch it on, and it cannot be switched on until they have been proven against the bank.'
      },
      credentialsValidatedAt: {
        type: ['string', 'null'], format: 'date-time',
        description: 'When the credentials were last exercised successfully against the bank. Null means unproven, and `enabled` cannot be true.'
      },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  WebhookAck: {
    type: 'object',
    properties: {
      received: { type: 'boolean' },
      settled: { type: 'boolean' },
      reason: {
        type: 'string',
        enum: ['SETTLED', 'DUPLICATE', 'FAILED', 'IGNORED', 'PROVIDER_MISMATCH', 'UNATTRIBUTED'],
        description: 'Why the delivery did or did not settle anything. Accepted and un-settled is a normal outcome, not an error.'
      }
    }
  }
});

module.exports = { schemas };
