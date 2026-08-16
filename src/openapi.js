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
        description: 'code is always VALIDATION_FAILED; details.fields carries one entry per failed field.',
        properties: {
          error: {
            type: 'object',
            properties: {
              details: {
                type: 'object',
                properties: {
                  fields: { type: 'array', items: { type: 'string' } }
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
      subtotalMinor: { ...minorUnits, description: 'Sum of the line items, before charges.' },
      vatBps: {
        type: 'integer', minimum: 0, maximum: 10000,
        description: 'IVA rate in basis points, frozen when the bill opened. 1600 = 16%.'
      },
      vatMinor: { ...minorUnits, description: 'IVA, taken on the subtotal alone — never on the service charge.' },
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
      usdReference: ref('UsdReference')
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
        description: 'ITEMS only. Every line on the bill must appear, or the split is refused.',
        items: {
          type: 'object',
          required: ['itemId', 'participantIds'],
          properties: {
            itemId: { type: 'string', format: 'uuid' },
            participantIds: {
              type: 'array', minItems: 1, items: { type: 'string' },
              description: 'More than one splits that line evenly between them.'
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
        description: 'IVA rate in basis points, frozen when the bill opened. 1600 = 16%.'
      },
      vatMinor: { ...minorUnits, description: 'IVA, taken on the subtotal alone — never on the service charge.' },
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
      created: { type: 'integer' },
      alreadyExisted: { type: 'integer' },
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

  Product: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      priceMinorUnits: minorUnits,
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      active: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' }
    }
  },

  // What a guest scanning a QR is shown: what a thing is and what it costs.
  // Inactive products are not listed, so `active` would always be true, and
  // edit timestamps are operational detail no diner needs.
  PublicProduct: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      description: { type: ['string', 'null'] },
      priceMinorUnits: minorUnits,
      currency: { type: 'string', enum: ['VES', 'USD', 'EUR'] }
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
      active: { type: 'boolean', default: true }
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
      active: { type: 'boolean' }
    }
  },

  PublicMenu: {
    type: 'object',
    properties: {
      restaurant: ref('MenuSettings'),
      products: { type: 'array', items: ref('PublicProduct') }
    }
  },

  MenuSettings: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] }
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
      restaurantId: { type: 'string', format: 'uuid' }
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
      }
    }
  },

  Account: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      rif: { type: ['string', 'null'], description: 'Null for restaurants that predate self-service registration.' },
      menuCurrency: { type: 'string', enum: ['VES', 'USD', 'EUR'] },
      vatBps: { type: 'integer' },
      serviceChargeBps: { type: 'integer' },
      plan: ref('Plan'),
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

  StaffPaymentClaim: {
    allOf: [
      ref('PaymentClaim'),
      {
        type: 'object',
        description: "The corroborating detail, which goes only to staff — `phoneOrigin` is a diner's personal number.",
        properties: {
          phoneOrigin: { type: ['string', 'null'] },
          bankOrigin: { type: ['string', 'null'] },
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
      phoneOrigin: { type: 'string', description: 'Optional. Not proof, but it is how a movement is found quickly.' },
      bankOrigin: { type: 'string', description: 'Optional.' }
    }
  },

  WebhookAck: {
    type: 'object',
    properties: {
      received: { type: 'boolean' },
      settled: { type: 'boolean' },
      reason: {
        type: 'string',
        enum: ['SETTLED', 'DUPLICATE', 'FAILED', 'IGNORED', 'PAYMENT_NOT_FOUND', 'UNATTRIBUTED'],
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

  '/api/v1/auth/login': {
    post: {
      tags: ['Auth'],
      summary: 'Exchange credentials for a session',
      description:
        'Rate limited to 10/minute per IP, and fails closed in production: if Redis is unavailable this returns 503 rather than waving brute-force attempts through. Unknown and known emails take the same time.',
      security: [],
      requestBody: { required: true, content: { 'application/json': { schema: ref('LoginRequest') } } },
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
      summary: 'Create a table',
      'x-required-roles': ['OWNER', 'MANAGER'],
      description: 'Roles: OWNER, MANAGER.',
      security: staff,
      requestBody: { required: true, content: { 'application/json': { schema: ref('CreateTableRequest') } } },
      responses: {
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
        'number in a form should be able to destroy.'
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
      description: 'Any authenticated staff role.',
      security: staff,
      responses: {
        200: { description: 'Settings, including charge rates.', content: { 'application/json': { schema: ref('MenuCharges') } } },
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

  '/api/v1/menu/products': {
    get: {
      tags: ['Menu'],
      summary: 'List menu products',
      description: 'Any authenticated staff role.',
      security: staff,
      parameters: [
        { $ref: '#/components/parameters/Limit' },
        { $ref: '#/components/parameters/Offset' },
        { name: 'active', in: 'query', schema: { type: 'boolean' } }
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
      description: 'Roles: OWNER, MANAGER. Partial update; at least one field is required.',
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
      'is reported as 404 rather than 403, so an endpoint never confirms that it exists.'
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
