const Joi = require('joi');

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

const splitQuerySchema = Joi.object({
  diners: Joi.number().integer().min(1).max(50).required()
});

const paginationKeys = {
  limit: Joi.number().integer().min(1).max(100).default(50),
  offset: Joi.number().integer().min(0).default(0)
};

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
    if (error) return res.status(400).json({ error: error.details.map(d => d.message) });
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
  updateTableSchema,
  createBillSchema,
  listTablesQuerySchema,
  listBillsQuerySchema,
  splitQuerySchema,
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
