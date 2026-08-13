const Joi = require('joi');
const { ApiError } = require('../errors');

const uuid = Joi.string().uuid({ version: 'uuidv4' });

const registerSchema = Joi.object({
  restaurantName: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().email({ minDomainSegments: 2 }).max(254).lowercase().required(),
  password: Joi.string().min(12).max(128).required()
});

const loginSchema = Joi.object({
  email: Joi.string().email({ minDomainSegments: 2 }).max(254).lowercase().required(),
  password: Joi.string().min(1).max(128).required()
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().min(20).max(4096).required()
});

const guestSessionSchema = Joi.object({
  qrToken: Joi.string().min(20).max(4096).required()
});

/**
 * BIGINT minor units.
 *
 * Accepted as a digit string so a total beyond 2^53 survives the request: a
 * JSON number has already lost precision by the time it reaches us. Plain
 * integers are still accepted for convenience and normalised to a string, so
 * every call site downstream sees one type.
 */
const minorUnits = Joi.alternatives()
  .try(
    Joi.string().trim().pattern(/^[0-9]{1,18}$/),
    Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER)
  )
  .custom(value => String(value));

/**
 * The same, but strictly greater than zero.
 *
 * A payment of nothing is not a payment; the ledger would record a row that
 * moved no money.
 */
const positiveMinorUnits = minorUnits.custom((value, helpers) =>
  (BigInt(value) > 0n ? value : helpers.error('any.invalid')), 'positive amount');

const splitPaymentSchema = Joi.object({
  billId: uuid.required(),
  // A digit string, so a payment can be as large as the BIGINT column holds.
  // Joi.number() coerced the value before validating it, which meant even the
  // exact string "9007199254740993" was rounded and then rejected as unsafe --
  // capping payments below 2^53 while the column and the arithmetic both went
  // further.
  amountMinorUnits: positiveMinorUnits.required(),
  // Settlement is VES only. USD and USDT were previously accepted and applied
  // at face value against a bolívar balance. USD now appears in responses as a
  // display reference, never as a payment amount.
  currency: Joi.string().valid('VES').required(),
  idempotencyKey: Joi.string().trim().min(16).max(128).pattern(/^[A-Za-z0-9._:-]+$/).required()
});

const createTableSchema = Joi.object({
  name: Joi.string().trim().min(1).max(50).required()
});

const updateTableSchema = Joi.object({
  name: Joi.string().trim().min(1).max(50),
  active: Joi.boolean()
}).min(1);

const createBillSchema = Joi.object({
  tableId: uuid.required(),
  // Minor units in the restaurant's menu currency. The currency itself is not
  // accepted here: it comes from the restaurant, so a bill cannot be opened in
  // a currency the menu does not use.
  totalDueMinorUnits: minorUnits.required()
});

// 999 matches the database CHECK. Bounded on purpose: quantity multiplies into
// a BIGINT subtotal, and an unbounded value turns an overflow into a failed
// insert in the middle of a service.
const quantity = Joi.number().integer().min(1).max(999);

const addBillItemSchema = Joi.object({
  productId: uuid.required(),
  quantity: quantity.default(1)
});

const updateBillItemSchema = Joi.object({
  quantity: quantity.required()
});

// A waiter takes an order, not a line: "two beers and a burger" is one action.
const orderSchema = Joi.object({
  items: Joi.array().min(1).max(50).required().items(Joi.object({
    productId: uuid.required(),
    quantity: quantity.default(1)
  }))
});

const billItemIdParamSchema = Joi.object({
  id: uuid.required(),
  itemId: uuid.required()
});

// A participant id is opaque to the backend: the client owns identity until
// persisted participants land with the guest claim flow. It is bounded and
// pattern-checked so it can be echoed back safely and read in a log line.
const participantId = Joi.string().min(1).max(64).pattern(/^[A-Za-z0-9._:-]+$/);

const splitPreviewSchema = Joi.object({
  mode: Joi.string().valid('FULL', 'EQUAL', 'ITEMS', 'CUSTOM').required(),
  participants: Joi.array().min(1).max(50).required().items(Joi.object({
    id: participantId.required(),
    name: Joi.string().trim().max(80),
    // CUSTOM only. Validated for exactness against the outstanding balance in
    // the engine, where the bill is known.
    amountVes: minorUnits
  })),
  // ITEMS only.
  claims: Joi.array().max(500).items(Joi.object({
    itemId: uuid.required(),
    participantIds: Joi.array().min(1).max(50).required().items(participantId)
  }))
});


const paginationKeys = {
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0)
};

// "I have 12 tables" -- the owner states how many the restaurant has and the
// missing ones are created. 200 is well past any real dining room and bounds a
// single request.
// The number is joined to the prefix with a space -- "Mesa" becomes "Mesa 1"
// -- rather than the caller having to supply a trailing space that trimming
// would silently remove and turn into "Mesa1".
const bulkTablesSchema = Joi.object({
  count: Joi.number().integer().min(1).max(200).required(),
  prefix: Joi.string().trim().min(1).max(20).default('Mesa')
});

const listTablesQuerySchema = Joi.object({
  ...paginationKeys,
  active: Joi.boolean()
});

const listBillsQuerySchema = Joi.object({
  ...paginationKeys,
  status: Joi.string().valid('OPEN', 'CLOSED', 'VOID'),
  tableId: uuid
});

const MENU_CURRENCIES = ['VES', 'USD', 'EUR'];

const menuCurrencySchema = Joi.object({
  currency: Joi.string().valid(...MENU_CURRENCIES).required()
});

const createProductSchema = Joi.object({
  name: Joi.string().trim().min(1).max(160).required(),
  description: Joi.string().trim().max(500).allow('', null),
  // Minor units in the restaurant's menu currency. The currency itself is not
  // accepted here: it is copied from the restaurant so a product can never
  // disagree with the menu it belongs to.
  priceMinorUnits: minorUnits.required(),
  active: Joi.boolean().default(true)
});

const updateProductSchema = Joi.object({
  name: Joi.string().trim().min(1).max(160),
  description: Joi.string().trim().max(500).allow('', null),
  priceMinorUnits: minorUnits,
  active: Joi.boolean()
}).min(1);

const listProductsQuerySchema = Joi.object({
  ...paginationKeys,
  active: Joi.boolean()
});

const billIdParamSchema = Joi.object({ id: uuid.required() });
const tableIdParamSchema = Joi.object({ tableId: uuid.required() });
const productIdParamSchema = Joi.object({ id: uuid.required() });
const restaurantIdParamSchema = Joi.object({ restaurantId: uuid.required() });

function validate(schema, property) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], { abortEarly: false, stripUnknown: true, convert: true });
    if (error) {
      // The per-field list moves into details.fields. It used to be the whole
      // body -- `{ error: [...] }` -- which is a third shape a client had to
      // recognise on top of the two others.
      return next(new ApiError('VALIDATION_FAILED', 'Request validation failed', {
        fields: error.details.map(d => d.message)
      }));
    }
    if (property === 'body') req[property] = value;
    else Object.assign(req[property], value);
    next();
  };
}

const validateBody = schema => validate(schema, 'body');
const validateParams = schema => validate(schema, 'params');
const validateQuery = schema => validate(schema, 'query');

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  guestSessionSchema,
  splitPaymentSchema,
  minorUnits,
  positiveMinorUnits,
  createTableSchema,
  bulkTablesSchema,
  updateTableSchema,
  createBillSchema,
  addBillItemSchema,
  orderSchema,
  updateBillItemSchema,
  billItemIdParamSchema,
  splitPreviewSchema,
  listTablesQuerySchema,
  listBillsQuerySchema,
  MENU_CURRENCIES,
  menuCurrencySchema,
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  restaurantIdParamSchema,
  billIdParamSchema,
  tableIdParamSchema,
  validate,
  validateBody,
  validateParams,
  validateQuery
};
