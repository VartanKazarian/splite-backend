const config = require('./config');
const { CODES, DETAILS } = require('./errors');

/**
 * OpenAPI 3.1 description of the API.
 *
 * This is a contract, not a brochure. `test/openapi.test.js` fails if a route
 * exists that is not described here, or if this describes a route that is not
 * mounted — which is how the tables router was found to be documented in the
 * README but absent from the app. It also enforces that every operation states
 * its authentication, its roles, and the error responses a client must handle.
 *
 * RBAC has no native OpenAPI representation, so required roles are carried in
 * `x-required-roles` and repeated in prose for humans.
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
          declaredAt: { type: ['string', 'null'], format: 'date-time' }
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
      tipVes: { ...minorUnits, description: 'Optional voluntary tip, default 0. Part of the same transfer: staff verify `amountVes + tipVes` as one figure against the bank app.' }
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
      lines: { type: 'array', items: ref('FiscalInvoiceLine'), description: 'Only on a single-invoice read.' },
      taxes: { type: 'array', items: ref('FiscalInvoiceTax'), description: 'Only on a single-invoice read.' }
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

const onboardingPaths = {
  '/api/v1/onboarding/restaurants': {
    post: {
      tags: ['Onboarding'],
      summary: 'Submit a restaurant for review',
      operationId: 'submitLead',
      'x-feature-flag': 'ONBOARDING_ENABLED',
      description: [
        'Public. Creates **no tenant and no account.** It records the submission and emails the',
        'Splite onboarding team, who read it and telephone the restaurant. The applicant gets an',
        'acknowledgement saying exactly that.',
        '',
        'Access is granted later, by a person: after the call, the team runs',
        '`npm run onboarding -- invite <id>`, which mails the single-use link that',
        '`POST /api/v1/onboarding/verify` consumes. There is no HTTP route for that step —',
        'every authenticated surface here is scoped to a tenant the caller belongs to, and there',
        'is no platform-operator role to authorise it.',
        '',
        'Returns the same 202 to everyone, including when the address or RIF already belongs to a',
        'live account. Anything else would make this an account-enumeration oracle, which is what',
        '`/auth/login` pays for a decoy Argon2 hash to avoid. The duplicate is reported to the',
        'reviewer instead, which is where a human should be looking at it anyway.',
        '',
        'Rate limited to 5/hour per source address **and** 3/hour per recipient, both fail-closed.',
        'The per-recipient limit is the one that matters: this endpoint sends mail to an address the',
        'caller chooses, so a distributed caller stays under any per-IP budget while filling one',
        "person's inbox."
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('SignupRequest') } } },
      responses: {
        202: {
          description: 'Received. The onboarding team has been notified; no account exists yet.',
          content: { 'application/json': { schema: ref('SignupAccepted') } }
        },
        400: response('BadRequest'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/onboarding/verify': {
    post: {
      tags: ['Onboarding'],
      summary: 'Consume the link, create the restaurant, sign the owner in',
      operationId: 'verifySignup',
      'x-feature-flag': 'ONBOARDING_ENABLED',
      description: [
        'Public, but requires a token that the Splite team sent by email after approving the',
        'submission. Nothing mints that token except `npm run onboarding -- invite <id>`.',
        '',
        'Creates the restaurant, its OWNER user and the menu defaults (IVA 1600 bps, servicio',
        '1000 bps) in **one transaction**, then issues a session — the address is proven and the',
        'password was chosen in this same request, so a login screen here would only ask for what',
        'was just typed.',
        '',
        'A human having approved the lead is *not* why this step exists: being vouched for is not',
        'the same as controlling the inbox, and staff email is globally unique. The tenant is still',
        'born only inside the transaction that spends the token.',
        '',
        'The link is single-use and expiring. `ONBOARDING_TOKEN_INVALID` covers absent, spent and',
        'expired alike: a caller has no legitimate use for the difference, and separating them would',
        'reveal which links exist.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('VerifyRequest') } } },
      responses: {
        201: {
          description: 'Restaurant created and signed in.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  ref('Session'),
                  { type: 'object', properties: { restaurant: ref('Account') } }
                ]
              }
            }
          }
        },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        409: response('Conflict'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  }
};

const paths = {
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

  '/api/v1/auth/login/mfa': {
    post: {
      tags: ['Auth'],
      summary: 'Complete a login with a second factor',
      operationId: 'completeMfaLogin',
      description: [
        'Spends the challenge from `/auth/login` together with a code, and returns the session that',
        'the password alone did not.',
        '',
        'The `code` field takes **either** a six-digit TOTP code or a recovery code, and the response',
        'does not say which was used. Both complete the login; distinguishing them would tell somebody',
        'holding a stolen password which secret they were guessing against.',
        '',
        'Every failure is 401 `INVALID_CREDENTIALS` — an expired challenge, a wrong code, a spent',
        'recovery code, an account deactivated in the meantime. Throttled per account, and asking',
        '`/auth/login` for a fresh challenge does not reset that budget.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaChallengeRequest') } } },
      responses: {
        200: { description: 'Session issued.', content: { 'application/json': { schema: ref('Session') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/auth/mfa': {
    get: {
      tags: ['Auth'],
      summary: 'Whether the caller has a second factor',
      operationId: 'getMfaStatus',
      security: staff,
      description:
        'The caller\'s own account only. Nothing here reads, enrols or removes another user\'s factor, including for an OWNER: a manager who could strip a colleague\'s second factor could take over their account.',
      responses: {
        200: { description: 'Second-factor status.', content: { 'application/json': { schema: ref('MfaStatus') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/auth/mfa/enrol': {
    post: {
      tags: ['Auth'],
      summary: 'Begin enrolling a second factor',
      operationId: 'beginMfaEnrolment',
      security: staff,
      description: [
        'Mints a TOTP secret and returns it with an `otpauth://` URI for a QR code. **Nothing is',
        'enabled yet:** the account still signs in on its password alone until a code is confirmed,',
        'which is what makes a failed scan a retry rather than a lockout.',
        '',
        'Calling it again before confirming replaces the secret. 409 `MFA_ALREADY_ENABLED` once a',
        'factor is live — disable it first, which costs a code.',
        '',
        '503 `MFA_KEY_MISSING` when the deployment has no `MFA_SECRET_KEYS` ring configured.'
      ].join('\n'),
      responses: {
        201: { description: 'Secret minted.', content: { 'application/json': { schema: ref('MfaEnrolment') } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/mfa/confirm': {
    post: {
      tags: ['Auth'],
      summary: 'Turn on the second factor with a code',
      operationId: 'confirmMfaEnrolment',
      security: staff,
      description: [
        'Proves the authenticator holds the secret, and only then does the factor become live.',
        '',
        'Returns the recovery codes, which are **the only time they are readable** — they are stored',
        'hashed. They are not optional: this system has no admin surface, so an owner who loses their',
        'phone with no code is locked out of their own business with nobody able to let them back in.'
      ].join('\n'),
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaCodeRequest') } } },
      responses: {
        200: { description: 'Enabled, with recovery codes.', content: { 'application/json': { schema: ref('MfaRecoveryCodes') } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/mfa/disable': {
    post: {
      tags: ['Auth'],
      summary: 'Remove the second factor',
      operationId: 'disableMfa',
      security: staff,
      description:
        'Costs a code, TOTP or recovery. A live session is deliberately not enough: a borrowed unlocked laptop would otherwise be able to strip the factor and leave the account on a password its borrower may already have.',
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaCodeRequest') } } },
      responses: {
        200: { description: 'Disabled.', content: { 'application/json': { schema: { type: 'object', properties: { disabled: { type: 'boolean' } } } } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/mfa/recovery-codes': {
    post: {
      tags: ['Auth'],
      summary: 'Replace the recovery codes',
      operationId: 'regenerateMfaRecoveryCodes',
      security: staff,
      description:
        'A fresh sheet for somebody who has spent theirs. Costs a code, and invalidates every code issued before it — including any still unspent on a sheet somebody else may be holding.',
      requestBody: { required: true, content: { 'application/json': { schema: ref('MfaCodeRequest') } } },
      responses: {
        200: { description: 'New codes.', content: { 'application/json': { schema: ref('MfaRecoveryCodes') } } },
        ...commonErrors,
        409: response('Conflict')
      }
    }
  },

  '/api/v1/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Exchange credentials for a session',
      description: [
        'Rate limited to 10/minute per IP, and fails closed in production: if Redis is unavailable this',
        'returns 503 rather than waving brute-force attempts through. Unknown and known emails take the',
        'same time.',
        '',
        'When the account has a second factor, a correct password does **not** return a session. It',
        'returns `{ mfaRequired: true, challenge }`, and the challenge is spent at',
        '`POST /api/v1/auth/login/mfa`. Branch on `mfaRequired`, not on the absence of a token.'
      ].join('\n'),
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('LoginRequest') } } },
      responses: {
        200: {
          description: 'A session, or an MFA challenge when the account has a second factor.',
          content: { 'application/json': { schema: { oneOf: [ref('Session'), ref('MfaChallenge')] } } }
        },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/auth/password': {
    post: {
      tags: ['Auth'],
      summary: 'Change your own password',
      operationId: 'changePassword',
      description: [
        'Any authenticated staff role, for their own account only — there is no user id in the path,',
        'because the only account you may change here is the one you are signed in as. An',
        'administrator changing somebody else\'s uses `POST /api/v1/account/users/{userId}/password`.',
        '',
        'The current password is required, and that is the guard: an access token in somebody else\'s',
        'hands should not be enough to take an account permanently. It is deliberately **not** counted',
        'against the login throttle — that throttle locks an account, so wiring this into it would let',
        'anyone holding a stolen token lock the real owner out, turning a containable compromise into',
        'a denial of service against the person best placed to fix it. The auth rate limit bounds it.',
        '',
        '**Answers like a login**, because that is what you now hold: every refresh session is revoked',
        'and these are the replacements, so the device doing the changing stays signed in and every',
        'other one is signed out. `sessionsRevoked` counts them.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['currentPassword', 'newPassword'],
              properties: {
                currentPassword: {
                  type: 'string', minLength: 1, maxLength: 128,
                  description: 'Bounded only at the top: it was set under whatever rule was in force when it was chosen, and refusing to read a short legacy password would leave its owner unable to replace it.'
                },
                newPassword: { type: 'string', minLength: 12, maxLength: 128 }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Changed, with a fresh session.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  ref('Session'),
                  {
                    type: 'object',
                    properties: {
                      sessionsRevoked: { type: 'integer', description: 'Other devices signed out.' }
                    }
                  }
                ]
              }
            }
          }
        },
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/auth/me': {
    get: {
      tags: ['Auth'],
      summary: 'The current user',
      operationId: 'getCurrentUser',
      description: [
        'What a client calls when restoring a session on boot. Any authenticated staff role.',
        '',
        '**Use this rather than /auth/refresh to identify the caller.** Refresh *rotates*: two tabs',
        'starting at once both present the same stored token, one claims it, and the other is',
        'treated as theft and revokes every session for that user. Calling refresh merely to ask',
        '"who am I" turns a second browser tab into a logout.',
        '',
        'Read from the database rather than the token, so a deactivated account stops working',
        'inside the access token\'s fifteen minutes rather than at the end of them.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'The caller. Identical in shape to `user` in a login or refresh response.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { user: ref('SessionUser') }
              }
            }
          }
        },
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    },

    patch: {
      tags: ['Auth'],
      summary: 'Set your own display name',
      operationId: 'setOwnDisplayName',
      description: [
        'Anyone signed in, on their own account only. The user id comes from the token, so there',
        'is no id to send and no way to rename somebody else from here -- renaming other staff is',
        '/staff, with its own permissions.',
        '',
        'The empty string clears the name. That is the gesture people expect from emptying the',
        'field, and the alternative would be a separate action meaning "remove my name".',
        '',
        'Changes nothing else: not the role, not the email, and not the sessions. Being called',
        'something different is not a reason to sign anybody out.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('DisplayNameRequest') } } },
      responses: {
        200: {
          description: 'The caller, in the same shape as GET, so a client refreshes what it already stored.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { user: ref('SessionUser') } }
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

  '/api/v1/auth/refresh': {
    post: {
      tags: ['Auth'],
      summary: 'Rotate a refresh token',
      description:
        'Rotation is atomic. Presenting an already-revoked token is treated as theft and revokes every session for that user.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('RefreshRequest') } } },
      responses: {
        200: { description: 'New session issued.', content: { 'application/json': { schema: ref('Session') } } },
        400: response('BadRequest'),
        401: response('Unauthorized'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/auth/logout': {
    post: {
      tags: ['Auth'],
      summary: 'Revoke a refresh session',
      description: 'Always 204, so it never reveals whether the token was valid.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('RefreshRequest') } } },
      responses: {
        204: { description: 'Revoked, or the token was already invalid.' },
        400: response('BadRequest'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

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
        'Rate limited to 30 requests a minute per IP.'
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

  '/api/v1/tables': {
    get: {
      tags: ['Tables'],
      summary: 'List tables',
      description: 'Any authenticated staff role.',
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'active', in: 'query', schema: { type: 'boolean' } }
      ],
      responses: {
        200: { description: 'Tables.', content: { 'application/json': { schema: ref('TableList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Tables'],
      summary: 'Create a table, or bring back the deleted one with that name',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Deleting a table is `PATCH { active: false }` \u2014 there is no DELETE, because a table',
        'carries bills and history. The row therefore keeps its name under UNIQUE (restaurant_id,',
        'name) while disappearing from every screen that filters on `active`, so creating that',
        'name again is a conflict with a table nobody can see.',
        '',
        'It is therefore reactivated instead of refused, and answers **200** with the original',
        'table \u2014 same id, same created_at, same QR. A guest QR lookup requires `active = true`,',
        'so the printed sticker died with the deactivation and comes back with the table; a new',
        'row would leave that sticker dead.',
        '',
        'A name an **active** table is using is still refused with 409 TABLE_NAME_TAKEN.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('CreateTableRequest') } } },
      responses: {
        200: {
          description: 'A deleted table with this name was reactivated. Nothing was created.',
          content: { 'application/json': { schema: ref('Table') } }
        },
        201: { description: 'Created.', content: { 'application/json': { schema: ref('Table') } } },
        ...commonErrors,
        403: response('Forbidden'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/tables/floor': {
    get: {
      tags: ['Tables'],
      summary: 'Every table with the bill open on it',
      operationId: 'getFloor',
      description: [
        'Any authenticated staff role. What an owner dashboard renders.',
        '',
        'One call instead of 1 + N: listing tables and then asking each for its open bill costs',
        'a request per table on every poll. `openBill` is null for a free table rather than absent,',
        'so the shape does not change with occupancy.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The floor.', content: { 'application/json': { schema: ref('FloorList') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/tables/bulk': {
    post: {
      tags: ['Tables'],
      summary: 'Create the tables a restaurant has',
      operationId: 'createTablesInBulk',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Say how many tables the restaurant has and the missing ones are',
        'created as `<prefix> 1` … `<prefix> N`.',
        '',
        'Idempotent, and it never deletes: raising the count later adds only the new tables, and',
        'lowering it removes nothing — a table that already carries bills is not something a',
        'number in a form should be able to destroy.',
        '',
        'A table inside the range that had been deleted (deactivated) comes back, and is reported',
        'under `reactivated`. Asking for ten tables and being handed nine, with nothing saying',
        'which is missing, is the deletion surprising the restaurant a second time. A deactivated',
        'table *outside* the range is left alone.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('BulkTablesRequest') } } },
      responses: {
        201: { description: 'Tables created.', content: { 'application/json': { schema: ref('BulkTablesResult') } } },
        ...commonErrors,
        403: response('Forbidden')
      }
    }
  },

  '/api/v1/tables/{tableId}': {
    patch: {
      tags: ['Tables'],
      summary: 'Update a table',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER. Partial update; at least one field is required.',
      security: staff,
      parameters: [{ $ref: '#/components/parameters/TableId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateTableRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('Table') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

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

  '/api/v1/menu/public/{restaurantId}/pdf': {
    parameters: [{ $ref: '#/components/parameters/RestaurantId' }],
    get: {
      tags: ['Menu'],
      summary: 'The uploaded menu, to a diner',
      description: [
        'Unauthenticated, like the public product list beside it and for the same reason: a diner',
        'scanning a table QR holds no staff credentials, and what this serves is a file the',
        'restaurant chose to publish.',
        '',
        'Served `inline` so a phone opens it rather than downloading it, with the restaurant\'s own',
        'filename so a diner who does save it gets something readable. `nosniff` is set: a stored',
        'file is served as what it says it is and nothing else.'
      ].join('\n'),
      security: [],
      responses: {
        200: {
          description: 'The file.',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } }
        },
        404: { description: 'Nothing uploaded, or no such restaurant.', content: { 'application/json': { schema: ref('Error') } } },
        400: { description: 'Malformed restaurant id.', content: { 'application/json': { schema: ref('Error') } } },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/api/v1/menu/public/{restaurantId}/products': {
    get: {
      tags: ['Menu'],
      summary: 'Public menu for a restaurant',
      description: 'Unauthenticated: a guest scanning a table QR holds no staff credentials.',
      security: [],
      parameters: [{ $ref: '#/components/parameters/RestaurantId' }],
      responses: {
        200: { description: 'Active menu.', content: { 'application/json': { schema: ref('PublicMenu') } } },
        400: response('BadRequest'),
        404: response('NotFound'),
        429: response('TooManyRequests'),
        500: response('ServerError')
      }
    }
  },

  '/api/v1/menu/settings': {
    get: {
      tags: ['Menu'],
      summary: 'Restaurant menu settings',
      operationId: 'getMenuSettings',
      description: [
        'Any authenticated staff role.',
        '',
        '**Read `menuOcrAvailable` before offering the photo import.** Reading a menu from a photo is',
        'opt-in per deployment — it costs money per call and reaches a third party — so a server',
        'without a key configured answers `503 MENU_OCR_NOT_CONFIGURED`. Without this flag a client',
        'has no way to know that until after the user has chosen a file and waited for several',
        'megabytes to upload. Asking is free and the answer does not change between requests.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Settings, including charge rates and what this deployment can do.',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  ref('MenuCharges'),
                  {
                    type: 'object',
                    properties: {
                      menuOcrAvailable: {
                        type: 'boolean',
                        description: 'Whether this server can read a menu from a photo or PDF. False means hide the import, not retry it: it is a fact about the deployment, not a transient failure.'
                      }
                    }
                  }
                ]
              }
            }
          }
        },
        ...commonErrors,
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/settings/charges': {
    patch: {
      tags: ['Menu'],
      summary: 'Set the IVA and service charge rates',
      operationId: 'setMenuCharges',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Rates are **basis points**: 1600 is 16%, 1000 is 10%. Send either,',
        'or both.',
        '',
        'Both are snapshotted onto a bill when it opens, so changing them never reprices a meal',
        'already being eaten — and a bill that is already open **keeps the rates it started with**.',
        'The response reports how many open bills are therefore unaffected; close or void one if it',
        'needs the new figures.',
        '',
        'Both default to 0, including for Venezuela\'s statutory 16%: a restaurant is configured',
        'deliberately rather than by a migration guessing.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('MenuChargesRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('MenuChargesResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/settings/currency': {
    patch: {
      tags: ['Menu'],
      summary: 'Change the menu currency',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description:
        'Roles: OWNER, MANAGER. Refused with 409 `MENU_CURRENCY_MISMATCH` while any active product is still priced in the old currency; prices are never converted automatically.',
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('MenuCurrencyRequest') } } },
      responses: {
        200: { description: 'Changed.', content: { 'application/json': { schema: ref('MenuSettings') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/menu/ocr-extract': {
    post: {
      tags: ['Menu'],
      summary: 'Read a menu from a photo or PDF',
      operationId: 'extractMenuFromUpload',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Upload one menu file as `multipart/form-data` in the field **`file`** — JPEG, PNG, WebP or',
        'PDF. A PDF is rasterised page by page, up to the configured page cap.',
        '',
        '**This writes nothing.** It returns a draft for a person to check, then',
        '`POST /api/v1/menu/ocr-import` commits what they confirmed. The division is deliberate and',
        'is the same one a declared Pago Móvil uses: OCR misreads prices, and a wrong price is',
        'charged to every diner who orders that dish until somebody notices.',
        '',
        'Rows the reader could not price arrive with `priceMinorUnits: null` and `needsPrice: true`',
        'rather than being dropped — the item is real, and hiding it sends staff hunting for what was',
        'missed. Rows sharing a name are flagged `duplicateName`, since the menu is unique on',
        '(restaurant, name).',
        '',
        'Rate limited to 10 per minute: each call costs money at a third party.',
        '',
        '503 `MENU_OCR_NOT_CONFIGURED` when the deployment has no vision provider configured. That is',
        'not a transient failure and retrying will not help — check `menuOcrAvailable` on',
        '`GET /api/v1/menu/settings` and hide the import instead. The server needs `MENU_OCR_API_KEY`;',
        '`MENU_OCR_BASE_URL` defaults to OpenAI and selects the vendor.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: {
                file: { type: 'string', format: 'binary', description: 'JPEG, PNG, WebP or PDF. Bounded by MENU_OCR_MAX_UPLOAD_BYTES (8 MB default).' }
              }
            }
          }
        }
      },
      responses: {
        200: { description: 'The draft. Nothing was written.', content: { 'application/json': { schema: ref('MenuOcrDraft') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/menu/ocr-import': {
    post: {
      tags: ['Menu'],
      summary: 'Commit reviewed menu items',
      operationId: 'importMenuItems',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Writes the items a staff member confirmed. The extraction has no authority here — this body',
        'is equally valid having uploaded nothing, and is validated exactly like a hand-typed product.',
        '',
        'Products are created active, in the **restaurant\'s** menu currency; the request cannot name',
        'one, since that would allow a EUR product onto a VES menu.',
        '',
        '**Partial success is normal.** Each row is inserted inside its own savepoint, so one',
        'duplicate name rejects that row and keeps the rest — look at `errors` as well as',
        '`importedCount`.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('MenuOcrImportRequest') } } },
      responses: {
        201: { description: 'What was imported, and what was not.', content: { 'application/json': { schema: ref('MenuOcrImportResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/menu/categories': {
    get: {
      tags: ['Menu'],
      summary: 'List menu sections',
      description: [
        'Any authenticated staff role.',
        '',
        'Its own endpoint rather than a shape nested inside the product list, because the two are',
        'paginated differently: a client renders every section header at once and pages through the',
        'food underneath. Deriving the headers from one page of products would hide any section',
        'whose items fell past the limit.',
        '',
        '`uncategorisedCount` counts products filed under no section. They have no row here to',
        'appear under, and are precisely the ones somebody needs to notice.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'Sections in menu order.', content: { 'application/json': { schema: ref('MenuCategoryList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Menu'],
      summary: 'Create a menu section',
      description: [
        'OWNER and MANAGER.',
        '',
        'Until this existed the only way to get a section was an OCR import inventing them from the',
        'headings it read off a photograph — fine for a first menu, no use afterwards. A restaurant',
        'adding a dessert list had nowhere to say so.',
        '',
        'Omitting `position` files the section at the end of the menu, which is worked out here.',
        'Defaulting it to 0 instead would put every new section first and let the name tie-break',
        'decide the order.',
        '',
        'Names are unique per restaurant, and the collision is caught on the insert rather than',
        'pre-checked: SELECT-then-INSERT is a race, and two managers adding "Postres" at the same',
        'moment would both pass the check.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            position: { type: 'integer', minimum: 0, maximum: 9999, description: 'Omit for the end of the menu.' },
            active: { type: 'boolean', default: true }
          }
        } } }
      },
      responses: {
        201: { description: 'Created.', content: { 'application/json': { schema: ref('MenuCategory') } } },
        409: { description: 'A section with that name already exists.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/categories/order': {
    put: {
      tags: ['Menu'],
      summary: 'Reorder the menu sections',
      description: [
        'OWNER and MANAGER. The array *is* the order: `position` becomes the index.',
        '',
        'The whole order at once rather than one move at a time. Sending positions individually',
        'makes every intermediate state a state somebody could read — two sections both claiming',
        'position 3 while the next request is in flight — and a dropped request would leave the menu',
        'in one permanently.',
        '',
        'Applied inside a transaction. The statement matches only this restaurant\'s rows, so a list',
        'padded with another tenant\'s ids would reorder the rest and *then* fail; rolling back is',
        'what makes the 404 mean nothing happened.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          required: ['ids'],
          properties: {
            ids: {
              type: 'array', minItems: 1, maxItems: 200, uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
              description: 'Every section, in the order they should appear.'
            }
          }
        } } }
      },
      responses: {
        204: { description: 'Reordered.' },
        404: { description: 'One or more sections do not exist. Nothing was changed.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/categories/{id}': {
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
    patch: {
      tags: ['Menu'],
      summary: 'Rename, move or deactivate a section',
      description: [
        'OWNER and MANAGER. At least one field.',
        '',
        '`active: false` takes the whole section off the public menu with its products intact — the',
        'kitchen ran out of fish and the pescados block goes dark for the evening.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'application/json': { schema: {
          type: 'object',
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            position: { type: 'integer', minimum: 0, maximum: 9999 },
            active: { type: 'boolean' }
          }
        } } }
      },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('MenuCategory') } } },
        404: { description: 'No such section for this restaurant.', content: { 'application/json': { schema: ref('Error') } } },
        409: { description: 'A section with that name already exists.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Delete a menu section',
      description: [
        'OWNER and MANAGER.',
        '',
        '**Deleting a section does not delete its food.** The foreign key is',
        '`ON DELETE SET NULL (category_id)`, so its products fall back into the uncategorised bucket,',
        'still active and still sellable. Taking the dishes with the heading would be a way to lose a',
        'menu by tidying it.'
      ].join('\n'),
      security: staff,
      responses: {
        204: { description: 'Deleted. Its products are now uncategorised.' },
        404: { description: 'No such section for this restaurant.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/branding/{kind}': {
    put: {
      tags: ['Menu'],
      summary: "Set the restaurant's cover photo or logo",
      operationId: 'setBranding',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'OWNER and MANAGER. `multipart/form-data`, field `file`. JPEG, PNG or WebP.',
        '',
        'The shopfront a diner sees after scanning a table: the cover is wide and sits behind the',
        'name, the logo is square and sits on top of it. Both optional. Where they appear is the',
        'client\u2019s decision; the API stores two images and says where they are.',
        '',
        'A larger ceiling than a dish photo (`BRANDING_MAX_UPLOAD_BYTES`, 4 MB by default): a cover',
        'is a wide shot, and one that has to be cropped down usually ends up not uploaded at all.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['COVER', 'LOGO'] } }],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object',
          required: ['file'],
          properties: { file: { type: 'string', format: 'binary' } }
        } } }
      },
      responses: {
        200: { description: 'Stored.', content: { 'application/json': { schema: ref('BrandingImage') } } },
        400: { description: 'Not a supported image, no file, too large, or an unknown kind.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove the cover photo or logo',
      operationId: 'deleteBranding',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'OWNER and MANAGER. 404 if there was none.',
      security: staff,
      parameters: [{ name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['COVER', 'LOGO'] } }],
      responses: {
        204: { description: 'Removed.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/public/{restaurantId}/branding/{kind}': {
    get: {
      tags: ['Menu'],
      summary: "A restaurant's cover photo or logo, to a diner",
      operationId: 'getPublicBranding',
      description: [
        '**Unauthenticated**, like the public products beside it.',
        '',
        'Do not build this URL. Use `coverUrl` / `logoUrl` from the QR context or the public menu,',
        'which carry a `v=` suffix from the file\u2019s checksum \u2014 that is what makes a replaced image',
        'appear instead of the one a phone already cached, and what lets this be `immutable` for a',
        'year.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'kind', in: 'path', required: true, schema: { type: 'string', enum: ['COVER', 'LOGO'] } }
      ],
      responses: {
        200: {
          description: 'The image.',
          content: {
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/webp': { schema: { type: 'string', format: 'binary' } }
          }
        },
        304: { description: 'The client already has this image.' },
        404: { description: 'No image of that kind.', content: { 'application/json': { schema: ref('Error') } } },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/api/v1/menu/products/{id}/image': {
    put: {
      tags: ['Menu'],
      summary: 'Set a dish photo',
      operationId: 'setProductImage',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'OWNER and MANAGER. `multipart/form-data`, field `file`. JPEG, PNG or WebP.',
        '',
        'Optional per product, and always the restaurant\u2019s choice \u2014 a menu with no photographs must',
        'keep looking deliberate rather than unfinished. The ceiling is deliberately far below the',
        'menu PDF\u2019s: a PDF is fetched once by a diner who chose to open it, a dish photo by everyone',
        'at the table at once.',
        '',
        'The bytes are checked against the declared type, which catches a HEIC straight off an iPhone',
        'or a PDF dropped in the wrong box and says so plainly rather than storing something no',
        'browser will render.',
        '',
        'An upload replaces whatever was there; there is one photo per product. The **product** comes',
        'back, not the file, with `imageUrl` filled in so a screen can show the new photo without a',
        'second request.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object',
          required: ['file'],
          properties: {
            file: {
              type: 'string', format: 'binary',
              description: 'JPEG, PNG or WebP, up to PRODUCT_IMAGE_MAX_UPLOAD_BYTES (2 MB by default).'
            }
          }
        } } }
      },
      responses: {
        200: { description: 'Stored. The product, with imageUrl.', content: { 'application/json': { schema: ref('Product') } } },
        400: { description: 'Not a supported image, no file, or too large.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove a dish photo',
      operationId: 'deleteProductImage',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'OWNER and MANAGER. Removes the photo and leaves the product alone. 404 if there was none.',
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        204: { description: 'Removed.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/menu/public/{restaurantId}/products/{productId}/image': {
    get: {
      tags: ['Menu'],
      summary: 'A dish photo, to a diner',
      operationId: 'getPublicProductImage',
      description: [
        '**Unauthenticated**, like the public products beside it: a diner scanning a table QR has no',
        'staff credentials, and this serves a picture the restaurant chose to publish.',
        '',
        'Do not build this URL. Use the `imageUrl` on the product, which carries a `v=` suffix taken',
        'from the file\u2019s checksum \u2014 that is what makes a replaced photo appear instead of the one a',
        'phone already cached. Because the address changes with the picture, the response is',
        '`immutable` for a year; an `ETag` is still sent for a client that arrives without the suffix.',
        '',
        'Scoped by both ids: a product belonging to another restaurant is a 404 rather than a picture,',
        'and a deactivated product takes its photo off the menu with it.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'restaurantId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } },
        { name: 'productId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      responses: {
        200: {
          description: 'The photo.',
          content: {
            'image/jpeg': { schema: { type: 'string', format: 'binary' } },
            'image/png': { schema: { type: 'string', format: 'binary' } },
            'image/webp': { schema: { type: 'string', format: 'binary' } }
          }
        },
        304: { description: 'The client already has this photo.' },
        404: { description: 'No photo, or not this restaurant\u2019s product.', content: { 'application/json': { schema: ref('Error') } } },
        429: { $ref: '#/components/responses/TooManyRequests' },
        500: { $ref: '#/components/responses/ServerError' }
      }
    }
  },

  '/api/v1/menu/pdf': {
    get: {
      tags: ['Menu'],
      summary: 'The uploaded menu file, described',
      description: 'Any authenticated staff role. Metadata only — the panel needs to describe the file, not download it.',
      security: staff,
      responses: {
        200: { description: 'The stored file.', content: { 'application/json': { schema: ref('MenuDocument') } } },
        404: { description: 'Nothing uploaded.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    },
    put: {
      tags: ['Menu'],
      summary: 'Upload the menu file shown to diners',
      description: [
        'OWNER and MANAGER. `multipart/form-data`, field `file`.',
        '',
        'Distinct from `/menu/ocr-extract`, which reads a menu in order to throw the file away and',
        'keep the prices. This keeps the file and shows it: a restaurant whose menu is a designed PDF',
        'gets something in front of a diner immediately, before anybody has typed in a price.',
        '',
        'It does not replace `menu_products`. A bill is built from priced rows, and nothing here can',
        'be added to one — the PDF is for reading.',
        '',
        'An upload replaces whatever was there; there is one file per restaurant. The bytes are',
        'checked for the `%PDF-` header as well as the declared type, which mostly catches somebody',
        'uploading a photo of the menu to the wrong route and says so plainly.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: { 'multipart/form-data': { schema: {
          type: 'object',
          required: ['file'],
          properties: { file: { type: 'string', format: 'binary', description: 'A PDF, up to MENU_PDF_MAX_UPLOAD_BYTES (20 MB by default).' } }
        } } }
      },
      responses: {
        200: { description: 'Stored.', content: { 'application/json': { schema: ref('MenuDocument') } } },
        400: { description: 'Not a PDF, no file, or too large.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove the uploaded menu file',
      description: 'OWNER and MANAGER. The structured menu is untouched.',
      security: staff,
      responses: {
        204: { description: 'Removed.' },
        404: { description: 'Nothing uploaded.', content: { 'application/json': { schema: ref('Error') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/menu/products': {
    get: {
      tags: ['Menu'],
      summary: 'List menu products',
      description: [
        'Any authenticated staff role.',
        '',
        'Ordered as the menu reads: section position, then the product\'s position within it, then',
        'name. Uncategorised products sort last. Name is the tie-break rather than the sort —',
        'everything imported at once shares a position, and alphabetical-within-a-section is a',
        'reasonable default until somebody reorders it.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'active', in: 'query', schema: { type: 'boolean' } },
        {
          name: 'categoryId', in: 'query',
          schema: { oneOf: [{ type: 'string', format: 'uuid' }, { type: 'string', enum: ['none'] }] },
          description: 'Narrow to one section. `none` is the uncategorised bucket, which has no id and would otherwise be unreachable.'
        }
      ],
      responses: {
        200: { description: 'Products.', content: { 'application/json': { schema: ref('ProductList') } } },
        ...commonErrors
      }
    },
    post: {
      tags: ['Menu'],
      summary: 'Create a menu product',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER. The currency comes from the restaurant, not the request.',
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('CreateProductRequest') } } },
      responses: {
        201: { description: 'Created.', content: { 'application/json': { schema: ref('Product') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/menu/products/{id}': {
    patch: {
      tags: ['Menu'],
      summary: 'Update a menu product',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Partial update; at least one field is required.',
        '',
        'Changing the tax fields affects only bills opened afterwards. Every line freezes its own',
        'taxCategory and vatBps when it is added, exactly as it freezes the price, so declaring a',
        'dish exempt today does not move the IVA on a meal already served.',
        '',
        'Moving a product to a non-taxable category clears any vatBps it carried — that is what the',
        'change means. Sending a vatBps for a product whose stored category is not TAXABLE is refused',
        'with 409 `PRODUCT_TAX_CONFLICT`; change taxCategory in the same request, or first.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/ProductId' }],
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateProductRequest') } } },
      responses: {
        200: { description: 'Updated.', content: { 'application/json': { schema: ref('Product') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    },
    delete: {
      tags: ['Menu'],
      summary: 'Remove a menu product',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Deactivates by default — a bill already referencing the product',
        'must stay readable.',
        '',
        '`?permanent=true` deletes the row outright. That is safe: `bill_items.product_id` is',
        'ON DELETE SET NULL and every line carries its own name and price snapshot, so an old bill',
        'stays exactly as it was served and only loses the reporting link. Use it to clear products',
        'left behind by a menu-currency change.'
      ].join('\n'),
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/ProductId' },
        { name: 'permanent', in: 'query', schema: { type: 'boolean', default: false } }
      ],
      responses: {
        204: { description: 'Deactivated.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

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
                  invoiced: { type: 'boolean', description: 'True once a fiscal document exists for it, so the offer is not made twice.' }
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
        '`PLAN_UPGRADE_REQUIRED`) and the deployment to have an imprenta digital configured (503',
        '`FISCAL_PROVIDER_NOT_CONFIGURED`).',
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
        'leaving is a table\'s order, not four hundred portions. Rate limited to 10 per minute per session.'
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

  '/api/v1/payments/tips/mine': {
    get: {
      tags: ['Payments'],
      summary: 'Your own tips',
      operationId: 'getMyTips',
      description: [
        'Any authenticated staff role, **for themselves only** — there is no user id in the path.',
        '',
        'A waiter seeing their own total is the entire incentive for building tipping into the',
        'product; seeing everybody else\'s is a different feature with a different conversation',
        'behind it. A manager already has `byServer` on the shift report.',
        '',
        'Attributed through `bills.servedBy` at query time, so a manager correcting who served a',
        'table moves these figures with it.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }
      ],
      responses: {
        200: {
          description: 'Tips earned in the window.',
          content: { 'application/json': { schema: ref('MyTips') } }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/dashboard': {
    get: {
      tags: ['Payments'],
      summary: 'The whole floor in one call',
      operationId: 'getServiceSnapshot',
      description: [
        'Any authenticated staff role — a waiter needs to know which tables still owe money as much',
        'as an owner does.',
        '',
        '**The totals are summed in Postgres, not by the client.** Amounts cross the wire as strings',
        'because a browser\'s `Number` loses precision past 2^53, so a total a client assembled by',
        'adding them up is the one figure nobody checked.',
        '',
        '`from` bounds only the *since* figures — takings, tips, payment count. The floor and the',
        'queues are always **now**: an open bill is open whatever window somebody asked about.',
        '',
        'Unset, `from` means the start of the current day **in America/Caracas**, not UTC. There is',
        'no timezone on a restaurant and this product is Venezuela-only; in UTC a service ending at',
        '23:00 local lands in tomorrow, which would make the takings wrong for the last four hours of',
        'every evening. A service that crosses midnight should send `from` explicitly.',
        '',
        '**A declared Pago Móvil is not takings.** It appears under `claims.pending` and leaves',
        '`openBills.outstandingVes` untouched, because a diner saying they paid is not money until a',
        'member of staff has found it in the bank app.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'from', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } }
      ],
      responses: {
        200: {
          description: 'The room, the queues and the takings.',
          content: { 'application/json': { schema: ref('ServiceSnapshot') } }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/activity': {
    get: {
      tags: ['Payments'],
      summary: 'What has happened since the client last looked',
      operationId: 'getPaymentActivity',
      description: [
        'Any authenticated staff role. `data` is always oldest first, so it can be rendered in the',
        'order the things happened.',
        '',
        'A first call, with no `since`, returns the **latest** `limit` events rather than the oldest:',
        'a screen that has just opened wants what just happened. With `since`, the window is',
        'everything after it.',
        '',
        'Poll with the `asOf` from the previous response as `since` — never an entry\'s `at`. Those',
        'carry milliseconds while the stored timestamps carry microseconds, so an `at` used as a',
        'cursor sits just before the event it names, and that event is returned again on every poll.',
        '',
        'Two kinds, because they call for different reactions:',
        '',
        '- `SETTLED` — money became real. Table 6 has paid.',
        '- `DECLARED` — a diner *says* they paid. Somebody has to open the bank app.',
        '',
        '**This is deliberately not a push.** A real notification needs a service worker, a',
        'subscription store and a sender, none of which are built; a cursor is what makes polling',
        'cheap enough that the absence does not matter for a screen somebody is watching.',
        '',
        'Use `asOf` rather than a time the client made up — a clock running fast would otherwise skip',
        'events, and a skipped settlement is a table nobody knows has paid.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
        { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }
      ],
      responses: {
        200: {
          description: 'Events since the cursor, oldest first.',
          content: { 'application/json': { schema: ref('PaymentActivity') } }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/orders': {
    get: {
      tags: ['Orders'],
      summary: 'Orders diners sent that the floor has not seen',
      operationId: 'listGuestOrders',
      description: [
        'Any authenticated staff role, including WAITER — a waiter is exactly who needs this.',
        '',
        'A guest order writes its lines straight onto the bill; nothing here approves anything. This is',
        'the tray of "table 4 just ordered" notices, with what was ordered, so somebody can walk over or',
        'send it to the kitchen without opening the table to find out what it was.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Unseen orders, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('GuestOrder') } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/orders/summary': {
    get: {
      tags: ['Orders'],
      summary: 'How many orders are waiting to be seen',
      operationId: 'getGuestOrdersSummary',
      description:
        'The badge figure. Separate from the list for the same reason as the claims summary: a number on every screen should not be pulling whole orders to render itself.',
      security: staff,
      responses: {
        200: { description: 'The queue, as numbers.', content: { 'application/json': { schema: ref('GuestOrdersSummary') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/orders/{id}/ack': {
    post: {
      tags: ['Orders'],
      summary: 'Mark an order as seen',
      operationId: 'acknowledgeGuestOrder',
      description: [
        'Changes nothing about the bill — the lines went on it when the diner pressed send. This only',
        'takes the notice out of the tray and records who took it.',
        '',
        'Idempotent: two waiters tapping the same notice is ordinary, and the second one is not an error.',
        'Both get 200 with the final state, and only the call that changed something is audited.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: {
          description: 'The order, seen.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  acknowledgedAt: { type: 'string', format: 'date-time' }
                }
              }
            }
          }
        },
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/claims/summary': {
    get: {
      tags: ['Payments'],
      summary: 'How many declared payments are waiting, and for how long',
      operationId: 'getPaymentClaimsSummary',
      description: [
        'Any authenticated staff role — including WAITER, unlike confirming. A waiter cannot decide',
        'that money arrived, but they are the person standing in the room and should be able to see',
        'that somebody is waiting on the till.',
        '',
        'This exists because nothing else tells staff a claim arrived. A diner declares a Pago Móvil,',
        'nothing moves until a person finds it in the bank app, and if nobody opens the queue the',
        'diner leaves believing they have paid. Separate from `GET /claims` so a badge on every screen',
        'is not pulling full claim rows, payer phone numbers included, to render a number.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The queue, as two numbers.', content: { 'application/json': { schema: ref('ClaimsSummary') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/claims': {
    get: {
      tags: ['Payments'],
      summary: 'Declared payments awaiting verification',
      operationId: 'listPaymentClaims',
      description: 'Any authenticated staff role. Defaults to PENDING, which is the queue somebody has to work.',
      security: staff,
      parameters: [
        { name: 'billId', in: 'query', schema: { type: 'string', format: 'uuid' } },
        {
          name: 'status', in: 'query',
          schema: { type: 'string', enum: ['PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED'], default: 'PENDING' }
        },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }
      ],
      responses: {
        200: {
          description: 'Claims, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('StaffPaymentClaim') } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/claims/{id}/confirm': {
    post: {
      tags: ['Payments'],
      summary: 'Confirm the money arrived, and settle the bill',
      operationId: 'confirmPaymentClaim',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER. A waiter can take an order; deciding that money arrived',
        'is a cashier\'s job upwards.',
        '',
        'This is the moment the bill moves. It goes through the same settlement path as a staff',
        'split and a provider webhook, so a confirmed claim cannot overpay a bill or close one that',
        'was voided while it sat in the queue — 409 `PAYMENT_EXCEEDS_BALANCE` and `BILL_NOT_OPEN`',
        'are both reachable here and both mean the claim should be rejected instead.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'Settled.', content: { 'application/json': { schema: ref('PaymentResult') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
      }
    }
  },

  '/api/v1/payments/claims/{id}/reject': {
    post: {
      tags: ['Payments'],
      summary: 'Record that the money could not be found',
      operationId: 'rejectPaymentClaim',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER.',
        '',
        'FAILED rather than deleted: if a diner insists they paid, the record of what they declared',
        'and who rejected it is the only way to settle the argument. Rejecting also releases the',
        'reference, so a diner who simply mistyped can declare again.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      requestBody: {
        required: false,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: { reason: { type: 'string', maxLength: 500, description: '"No aparece" and "el monto no coincide" are different problems.' } }
            }
          }
        }
      },
      responses: {
        200: { description: 'Rejected.', content: { 'application/json': { schema: ref('StaffPaymentClaim') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict')
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

  '/api/v1/payments/tips': {
    get: {
      tags: ['Payments'],
      summary: 'Tips taken over a period',
      operationId: 'getTipsReport',
      description: [
        'Any authenticated staff role — this is the figure a shift is divided by, and whoever hands',
        'the money out has to be able to read it.',
        '',
        '`from` is inclusive and `to` exclusive, so consecutive shifts tile without counting the',
        'boundary twice. Both are required: a report whose period was guessed is a number somebody',
        'hands out money against.',
        '',
        '**The window is on settlement time**, not on when the payment row was created. Those differ',
        'for a declared Pago Móvil, which is created when the diner says they paid and settles when',
        'staff verify it. Windowing on settlement is what makes a past shift final: once its queue is',
        'worked, its number never changes again.',
        '',
        '**Only SUCCEEDED payments count.** A tip on an unverified Pago Móvil claim is money a diner',
        '*says* they sent, and paying staff against it is the mistake the confirmation step exists to',
        'prevent. IN_DOUBT and AMBIGUOUS C2P charges are excluded for the same reason.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
        { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }
      ],
      responses: {
        200: { description: 'Tips over the period.', content: { 'application/json': { schema: ref('TipsReport') } } },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/c2p/unresolved': {
    get: {
      tags: ['Payments'],
      summary: 'C2P charges that reached no settled state',
      operationId: 'listUnresolvedC2PCharges',
      description: [
        'Any authenticated staff role.',
        '',
        '`IN_DOUBT` means the bank never told us what happened. `AMBIGUOUS` means it has money',
        'matching the amount that nothing ties to this diner, or it confirmed a debit that could not',
        'be credited to the bill.',
        '',
        'This queue is what makes refusing to guess usable. A charge nobody is looking at is',
        'indistinguishable from one that was lost.'
      ].join('\n'),
      security: staff,
      parameters: [{ $ref: '#/components/parameters/Limit' }],
      responses: {
        200: {
          description: 'Unresolved charges, oldest first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('C2PUnresolvedCharge') } }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/payments/c2p/{id}/resolve': {
    post: {
      tags: ['Payments'],
      summary: 'Ask Mercantil what happened to an in-doubt charge',
      operationId: 'resolveC2PCharge',
      'x-required-roles': ['OWNER', 'MANAGER', 'CASHIER'],
      description: [
        'Roles: OWNER, MANAGER, CASHIER. This can settle a bill, so it is a cashier\'s job upwards.',
        '',
        'Settles only when a bank movement matches on **both** the amount and the last four digits',
        'of the payer\'s phone. Amount alone is a filter, never a decision: two tables owing the same',
        'total is the ordinary case in a restaurant, and matching on amount would settle one table',
        'with the other\'s money.',
        '',
        'A movement it cannot attribute moves the charge to `AMBIGUOUS` with the candidate',
        'references attached. Re-running an `AMBIGUOUS` charge returns it unchanged — the system has',
        'already said it cannot tell them apart, and asking again will not change that.',
        '',
        'Inside the settlement window a missing movement returns `resolutionPending` rather than',
        'failing the charge: interbank settlement is not instant, and failing a debit still in',
        'flight is the same double-charge error in slower motion.',
        '',
        '409 `PAYMENT_REFERENCE_ALREADY_USED` means the movement it matched had already settled a',
        'different payment. The charge stays unresolved.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: {
        200: { description: 'What asking the bank produced.', content: { 'application/json': { schema: ref('C2PResolution') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        503: response('ServiceUnavailable')
      }
    }
  },

  '/api/v1/webhooks/{provider}': {
    post: {
      tags: ['Webhooks'],
      summary: 'Inbound payment notification from a provider',
      operationId: 'receiveWebhook',
      description: [
        'No session: a provider has no login. The **HMAC signature is the credential**, and it is',
        'verified before the body is read, recorded or acted on.',
        '',
        'Headers: `X-Webhook-Signature` (hex HMAC-SHA256) and `X-Webhook-Timestamp` (unix seconds).',
        'The signed value is `{timestamp}.{rawBody}`, so a captured signature cannot be replayed',
        'against a different body, and the timestamp is inside the MAC rather than merely beside it.',
        'The tolerance window is two-sided: a far-future timestamp is as invalid as a stale one.',
        '',
        'A signature may be used **once**. Single-use is enforced in Redis and fails closed — if the',
        'replay store is unreachable this answers 503 `WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE`',
        'rather than risk handling a money-moving callback twice.',
        '',
        'The **amount is taken from our own record, never from the body.** A valid signature proves',
        'who sent the delivery and nothing more; settling whatever figure it names would let a',
        'compromised provider key rewrite a bill.',
        '',
        '**202 means stop sending this.** Settled, a duplicate of something settled, or a body that',
        'never named a payment and never will however many times it is resent. Providers retry on',
        'any non-2xx and on timeouts where we in fact succeeded, so answering a duplicate with an',
        'error teaches one to retry forever. Read `settled` and `reason` for what happened.',
        '',
        '**It does not cover a delivery we merely failed to process.** A callback can overtake the',
        'commit of our own PENDING row, and answering 202 to that loses a real settlement',
        'permanently — the money has moved and the bill never closes. Those answer 503',
        '`WEBHOOK_PAYMENT_UNRESOLVED` with `Retry-After`, as do database failures.',
        '',
        'Send an `eventId`. Duplicate detection is a primary key on `(provider, eventId)` written',
        'inside the settling transaction, which is durable and event-scoped; the signature-keyed',
        'Redis entry is a ten-minute optimisation that a re-signed retry does not match. Without an',
        '`eventId` the only protection left is the payment status check, which cannot tell two',
        'events for one payment apart. A failed attempt claims nothing, so the retry can succeed.',
        '',
        'Only the `SPLITE` provider exists today; a real acquirer is an entry in the adapter table.'
      ].join('\n'),
      security: [],
      parameters: [
        { name: 'provider', in: 'path', required: true, schema: { type: 'string' }, example: 'SPLITE' }
      ],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
      responses: {
        202: { description: 'Delivery accepted. Check `settled`.', content: { 'application/json': { schema: ref('WebhookAck') } } },
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

  '/api/v1/account/users': {
    get: {
      tags: ['Account'],
      summary: 'The people who work here',
      operationId: 'listStaff',
      description: [
        'OWNER and MANAGER only.',
        '',
        'Deactivated accounts are listed too, and last. They are the ones somebody needs to find in',
        'order to reinstate, and hiding them makes a reactivation look like a second account with the',
        'same address — which the unique index then refuses, confusingly.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Staff, active first.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { data: { type: 'array', items: ref('StaffMember') } }
              }
            }
          }
        },
        403: response('Forbidden'),
        ...commonErrors
      }
    },

    post: {
      tags: ['Account'],
      summary: 'Add somebody',
      operationId: 'createStaff',
      description: [
        'OWNER and MANAGER only, and a manager may only grant a role below their own — without that',
        'second half, "may manage staff" silently means "may become an owner".',
        '',
        'The password takes the same rule as registration rather than a laxer one: this account signs',
        'in through exactly the same door, so a shorter password here would be a quieter way into the',
        'same building. There is no self-service change yet, so tell the person what you set.',
        '',
        '`role` is required and not defaulted. What this person may do is the whole point of creating',
        'them, and a default would be the answer nobody chose.'
      ].join('\n'),
      security: staff,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['email', 'password', 'role'],
              properties: {
                email: { type: 'string', format: 'email', maxLength: 254 },
                password: { type: 'string', minLength: 12, maxLength: 128 },
                role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] }
              }
            }
          }
        }
      },
      responses: {
        201: {
          description: 'Created.',
          content: {
            'application/json': {
              schema: { type: 'object', properties: { user: ref('StaffMember') } }
            }
          }
        },
        403: response('Forbidden'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/users/{userId}': {
    patch: {
      tags: ['Account'],
      summary: 'Change a role, a standing, or both',
      operationId: 'updateStaff',
      description: [
        'OWNER and MANAGER only. Three rules apply, and each has its own error code:',
        '',
        '- **Rank.** An owner may act on anybody but themselves; anyone else only on a strictly lower',
        '  role, and may only grant one (`STAFF_OUTRANKED`, `STAFF_ROLE_TOO_HIGH`).',
        '- **Never yourself** (`STAFF_SELF_FORBIDDEN`). It stops an owner demoting themselves out of',
        '  the only account that could undo it, and costs nothing: another owner can still do it.',
        '- **The last active owner stays** (`STAFF_LAST_OWNER`), checked under lock so two requests',
        '  removing the last two owners cannot both see the other and succeed.',
        '',
        '**`sessionsRevoked` is the honest half of the answer.** Deactivating or changing a role kills',
        'every refresh token the person holds, so they cannot mint a new access token. The access',
        'token already in their hands keeps working until it expires — at most `JWT_ACCESS_TTL`,',
        'fifteen minutes by default. Somebody removing a person after an argument needs to know the',
        'door is not shut this second.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              minProperties: 1,
              description: 'At least one of the two: a PATCH that changes nothing is a request somebody meant to be a change.',
              properties: {
                role: { type: 'string', enum: ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'] },
                active: { type: 'boolean' }
              }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Updated.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  user: ref('StaffMember'),
                  sessionsRevoked: { type: 'integer', description: 'Refresh sessions ended by this change.' }
                }
              }
            }
          }
        },
        403: response('Forbidden'),
        404: response('NotFound'),
        409: response('Conflict'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/users/{userId}/password': {
    post: {
      tags: ['Account'],
      summary: "Set somebody else's password",
      operationId: 'resetStaffPassword',
      description: [
        'OWNER and MANAGER only, subject to the same rank and self rules as a role change.',
        '',
        'This is also how a forgotten password is recovered, because there is no self-service change',
        'yet. It revokes their sessions, which is the point: a reset that leaves the old sessions',
        'running has not locked anybody out.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'userId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }
      ],
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['password'],
              properties: { password: { type: 'string', minLength: 12, maxLength: 128 } }
            }
          }
        }
      },
      responses: {
        200: {
          description: 'Set.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { sessionsRevoked: { type: 'integer' } }
              }
            }
          }
        },
        403: response('Forbidden'),
        404: response('NotFound'),
        ...commonErrors
      }
    }
  },

  '/api/v1/account/contacts': {
    get: {
      tags: ['Account'],
      summary: 'Diners who asked to hear from the restaurant',
      operationId: 'listGuestContacts',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER.',
        '',
        'Not "everyone who has paid here": only the diners who ticked an empty box saying yes, and',
        'have not withdrawn since. That difference is the whole product — a list of people who',
        'agreed is worth something, and a list of people who merely wanted their invoice is a',
        'problem waiting.',
        '',
        'There is deliberately no parameter for "all the addresses". It would exist to be used, and',
        'the only thing to do with the others is send them something they did not ask for.'
      ].join('\n'),
      security: staff,
      parameters: [
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, default: 0 } }
      ],
      responses: {
        200: {
          description: 'Consented contacts, newest first.',
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
                        id: { type: 'string', format: 'uuid' },
                        email: { type: 'string' },
                        name: { type: ['string', 'null'] },
                        consentAt: { type: ['string', 'null'], format: 'date-time' }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        ...commonErrors,
        403: response('Forbidden')
      }
    }
  },

  '/api/v1/account/banks': {
    get: {
      tags: ['Account'],
      summary: 'Venezuelan banks a payee can be configured against',
      operationId: 'listBanks',
      description: [
        'Any authenticated staff role.',
        '',
        'Read `chargeable` rather than assuming: a restaurant may name any bank, because that is',
        'where diners send money whether or not we integrate with it, but only a bank with a module',
        'can take part in an in-app payment. Nothing is chargeable today.',
        '',
        '**The list is not officially sourced.** It has been cross-checked against two independent',
        'published lists, which agreed on every code, but the BCV register itself has not been read.',
        'The codes are load-bearing — a wrong one sends money to another institution — so confirming',
        'them against that register is a prerequisite for the first bank module.'
      ].join('\n'),
      security: staff,
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

  '/api/v1/account/payment-providers': {
    get: {
      tags: ['Account'],
      summary: 'Which bank rails this restaurant has credentials for',
      operationId: 'listPaymentProviders',
      description: [
        'Any authenticated staff role. Returns metadata only — there is no endpoint that returns a',
        'stored credential, and the schema has no field that could carry one.',
        '',
        '`supported` lists the providers this deployment has an adapter for.'
      ].join('\n'),
      security: staff,
      responses: {
        200: {
          description: 'Configured providers.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  data: { type: 'array', items: ref('PaymentProviderConfig') },
                  supported: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          }
        },
        ...commonErrors
      }
    }
  },

  '/api/v1/account/payment-providers/{provider}': {
    put: {
      tags: ['Account'],
      summary: 'Store bank API credentials',
      operationId: 'putPaymentProviderCredentials',
      'x-required-roles': ['OWNER'],
      description: [
        '**OWNER only** — not MANAGER, who may set the payee. The payee says where money should be',
        'sent; these let software move it, which is a different kind of authority.',
        '',
        'The body shape is per provider, because no two banks agree on what a credential is.',
        'MERCANTIL takes `merchantId`, `clientId`, `secretKey`, `integratorId` and `terminalId`.',
        'Unknown fields are rejected rather than stored: a blob that carries whatever was sent is',
        'where a stray password ends up, sealed forever and invisible to review.',
        '',
        'Credentials are sealed with AES-256-GCM before they reach the database and are never',
        'returned. Replacing them resets `enabled` to false and clears `credentialsValidatedAt` —',
        'new credentials are unproven credentials, and a mistyped key must not leave a rail',
        'switched on and quietly broken.',
        '',
        'Answers 503 `PAYMENT_CREDENTIALS_KEY_MISSING` when the deployment has no encryption key',
        'configured. That is configuration, not a bug, and the code says so.'
      ].join('\n'),
      security: staff,
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' }, example: 'MERCANTIL' }],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } }
      },
      responses: {
        200: { description: 'Stored.', content: { 'application/json': { schema: ref('PaymentProviderConfig') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound'),
        503: response('ServiceUnavailable')
      }
    },

    delete: {
      tags: ['Account'],
      summary: 'Remove bank API credentials',
      operationId: 'deletePaymentProviderCredentials',
      'x-required-roles': ['OWNER'],
      description: 'OWNER only. Removes the row outright; there is nothing to keep once the credentials are gone.',
      security: staff,
      parameters: [{ name: 'provider', in: 'path', required: true, schema: { type: 'string' } }],
      responses: {
        204: { description: 'Removed.' },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/account/payout': {
    put: {
      tags: ['Account'],
      summary: 'Set or clear where the restaurant is paid',
      operationId: 'setPayout',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. This is the address money is sent to — getting it wrong does not',
        'degrade the product, it pays a stranger — so it is not a change a waiter makes from the',
        'floor.',
        '',
        'Send all four fields, or `{}` to clear. The account number must begin with its own bank',
        'code, which is checked here rather than left to a database CHECK so the error names the',
        'field.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('PayoutRequest') } } },
      responses: {
        200: { description: 'The account, with its payee.', content: { 'application/json': { schema: ref('Account') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  '/api/v1/account': {
    get: {
      tags: ['Account'],
      summary: "The signed-in restaurant's own record and plan",
      operationId: 'getAccount',
      description: [
        'Any authenticated staff role.',
        '',
        'The source of the trial banner. Note what it does **not** do: nothing in the API refuses',
        'service when a trial lapses. Which action a lapsed restaurant loses is a pricing decision,',
        'and the obvious candidate is the wrong one — cutting off bills mid-service strands a dining',
        'room full of seated diners over an unpaid invoice. Until that is decided deliberately, the',
        'dates are reported and the client warns.'
      ].join('\n'),
      security: staff,
      responses: {
        200: { description: 'The restaurant and its plan.', content: { 'application/json': { schema: ref('Account') } } },
        ...commonErrors,
        404: response('NotFound')
      }
    },
    patch: {
      tags: ['Account'],
      summary: 'Update the restaurant',
      operationId: 'updateAccount',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: [
        'Roles: OWNER, MANAGER. Partial update; at least one field is required. Omitting a field',
        'leaves it as it is — in particular, changing the invoicing policy does not require',
        'resending the name, which is how a restaurant gets renamed by accident.',
        '',
        '`name` is what a diner reads on their phone the moment they scan the code on the table,',
        'above the table number. It could previously only be set during onboarding, which left',
        'whatever was typed that day in front of every customer with no way to correct it.',
        '',
        '`fiscalInvoicePolicy` is **OWNER only**, and answers with 403 `FORBIDDEN_ROLE` for a',
        'MANAGER. It is not profile editing: it decides how the restaurant declares, so it sits',
        'with the money decisions and is audited separately as `FISCAL_POLICY_CHANGED`.',
        '',
        'Menu currency, charges and the payee each still have their own endpoint, because each is',
        'a different decision with a different reach.'
      ].join('\n'),
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('UpdateAccountRequest') } } },
      responses: {
        200: { description: 'The updated restaurant.', content: { 'application/json': { schema: ref('Account') } } },
        ...commonErrors,
        403: response('Forbidden'),
        404: response('NotFound')
      }
    }
  },

  /**
   * Registration is described always, and served behind ONBOARDING_ENABLED.
   *
   * These were once spread in conditionally, so that the contract described
   * exactly what a given deployment answers. That was wrong for one decisive
   * reason: `openapi.json` is a *committed artifact*, and CI checks it byte for
   * byte with no `.env` present. A developer with the flag on in their `.env`
   * regenerates the file with these paths included, commits it, and every
   * subsequent CI run fails `openapi:check` on a file nobody can fix without
   * knowing about the flag.
   *
   * A published contract has to be a function of the code, not of the
   * environment that happened to serialise it. So the document is the whole
   * surface, `x-feature-flag` says which endpoints a deployment may not be
   * serving, and `test/openapi.test.js` knows to exempt them when the flag is
   * off.
   */
  ...onboardingPaths
};

const document = {
  openapi: '3.1.0',
  info: {
    title: 'Splite API',
    version: require('../package.json').version,
    description: [
      'Bill splitting for Venezuelan restaurants.',
      '',
      'Settlement is always VES in céntimos. USD and EUR are display references, never payment currencies.',
      '',
      '## Wire format conventions',
      '',
      'Every endpoint follows these rules. A frontend that trusts them never needs to guess.',
      '',
      '| Kind | JSON type | Format | Example |',
      '|------|-----------|--------|---------|',
      '| **Money** (minor units) | `string` | Digit string — no leading zeros except `"0"` | `"9007199254740993"` |',
      '| **FX rates** | `string` | Decimal, padded to 8 fractional digits | `"757.54060000"` |',
      '| **IDs** | `string` | UUID v4 | `"d290f1ee-6c54-4b01-90e6-d701748f0851"` |',
      '| **Timestamps** | `string` | ISO 8601 `date-time` | `"2025-03-05T16:30:00.000Z"` |',
      '| **Value dates** | `string` | ISO 8601 `date` | `"2025-03-06"` |',
      '',
      'Amounts are strings so values beyond 2^53 survive JSON (JavaScript `Number` loses',
      'precision past `Number.MAX_SAFE_INTEGER`). Rates are strings so every endpoint returns',
      'the same representation — no `757.5406` from one route and `"757.54060000"` from another.',
      '',
      'Every query is scoped to the caller\'s restaurant. A resource belonging to another tenant',
      'is reported as 404 rather than 403, so an endpoint never confirms that it exists.',
      '',
      '## Features that are off until configured',
      '',
      'Several capabilities cost money per call or reach a third party, so they are **opt-in per',
      'deployment**. A server without the setting refuses with a distinct 503 rather than failing',
      'oddly — but a 503 normally means "try later", and these do not. **`NOT_CONFIGURED` and',
      '`KEY_MISSING` mean stop offering the feature on this server**, not retry it. Nothing the',
      'caller does will change the answer.',
      '',
      '| Capability | Setting the server needs | Without it | Ask first |',
      '|---|---|---|---|',
      '| Read a menu from a photo or PDF | `MENU_OCR_API_KEY` | 503 `MENU_OCR_NOT_CONFIGURED` | `menuOcrAvailable` on `GET /api/v1/menu/settings` |',
      '| Enrol a second factor | `MFA_SECRET_KEYS` | 503 `MFA_KEY_MISSING`. Existing accounts keep signing in on passwords | `GET /api/v1/auth/mfa` |',
      '| Store bank API credentials | `PAYMENT_CREDENTIALS_KEYS` | 503 `PAYMENT_CREDENTIALS_KEY_MISSING` | — |',
      '| Charge a diner through Mercantil C2P | `MERCANTIL_C2P_URL`, **plus** credentials stored and proven per restaurant | 503 `PAYMENT_PROVIDER_MISCONFIGURED` | `chargeable` on `GET /api/v1/account/banks` |',
      '| Self-service restaurant signup | `ONBOARDING_ENABLED` and a mail provider | The routes are **not mounted at all**, so 404 | — |',
      '| Foreign-currency menu prices | `FX_ENABLED` (on by default) and a reachable BCV | 503 `FX_UNAVAILABLE`, after the stored-rate fallback is exhausted | `GET /api/v1/exchange-rate` |',
      '| Prometheus metrics at `/metrics` | `METRICS_TOKEN` | The route is **not mounted** — 404, not 401 | — |',
      '',
      'Declared Pago Móvil needs none of this and is the rail that works on a bare deployment: a',
      'diner declares a transfer, a member of staff confirms it against the bank app.',
      '',
      'Where a column above names something to ask, ask it — those endpoints answer from',
      'configuration and the answer does not change between requests. It is the difference between',
      'hiding a button and offering one that fails after the user has done the work.'
    ].join('\n'),
    'x-error-details': DETAILS,
    'x-wire-format': {
      money: { type: 'string', pattern: '^[0-9]+$', description: 'Integer minor units (céntimos) as a digit string.' },
      rate: { type: 'string', pattern: '^\\d+\\.\\d{8}$', description: 'Decimal rate padded to 8 fractional digits.' },
      id: { type: 'string', format: 'uuid', description: 'UUID v4.' },
      timestamp: { type: 'string', format: 'date-time', description: 'ISO 8601 date-time.' },
      valueDate: { type: 'string', format: 'date', description: 'ISO 8601 date (BCV publication date).' }
    }
  },
  servers: [
    { url: '/', description: 'This server' },
    { url: 'http://localhost:3000', description: 'Local development' }
  ],
  tags: [
    { name: 'Health' },
    { name: 'Auth' },
    { name: 'Guest' },
    { name: 'Tables' },
    { name: 'Bills' },
    { name: 'Payments' },
    { name: 'Orders' },
    { name: 'Menu' },
    { name: 'Exchange rate' },
    { name: 'Webhooks' },
    { name: 'Account' },
    // Listed unconditionally even though its operations are only described when
    // ONBOARDING_ENABLED is on: a tag with no operations reads as a feature that
    // exists and is switched off, which is true, whereas a tag that appears and
    // disappears reads as two different APIs.
    { name: 'Onboarding' }
  ],
  security: staff,
  components: {
    securitySchemes: {
      staffAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Short-lived staff access token from /api/v1/auth/login.'
      },
      guestAuth: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Guest session token. Send the token as a bearer credential *and* the session id in the `X-Guest-Session` header; both are required. Obtained from POST /api/v1/guest/sessions by presenting a signed table QR.'
      }
    },
    parameters,
    schemas,
    responses
  },
  paths
};

module.exports = { document, enabled: config.docs.enabled };
