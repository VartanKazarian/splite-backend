const Joi = require('joi');
const banks = require('../payments/banks');
const { ApiError } = require('../errors');
const { normaliseRif, hasRifShape } = require('../utils/rif');

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


/**
 * A diner declaring a Pago Móvil they have already sent.
 *
 * `reference` is what makes the claim checkable: it is the number the payer's
 * bank assigned, and it is what a member of staff will look for in the bank
 * app. Required for that reason -- a claim without one asks somebody to find an
 * unidentified transfer among the evening's takings.
 *
 * Loose about how it is typed, strict about what it becomes: the service keeps
 * digits only, so `0001234567`, `00012 34567` and `ref 0001234567` are one
 * reference and cannot each claim the bill separately.
 */
const declareClaimSchema = Joi.object({
  amountVes: positiveMinorUnits.required(),
  reference: Joi.string().trim().min(4).max(32).pattern(/^[\d\s.-]+$/).required(),
  // Optional corroboration. Neither is proof, and neither is required, but a
  // member of staff scanning a bank app finds a movement far faster with the
  // originating number than without it.
  phoneOrigin: Joi.string().trim().min(7).max(40).pattern(/^[+()\-.\s\d]+$/),
  bankOrigin: Joi.string().trim().max(60)
});

const listClaimsQuerySchema = Joi.object({
  billId: uuid,
  // PENDING by default: the queue somebody has to work is the reason this
  // endpoint exists.
  status: Joi.string().valid('PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED').default('PENDING'),
  limit: Joi.number().integer().min(1).max(100).default(50)
});

const rejectClaimSchema = Joi.object({
  // Free text, and worth capturing: "no aparece" and "el monto no coincide" are
  // different problems, and the second one is the restaurant's to chase.
  reason: Joi.string().trim().max(500)
});

const paymentIdParamSchema = Joi.object({ id: uuid.required() });

// Bounded and pattern-checked because it is echoed back in the error details
// when no adapter matches.
const webhookProviderParamSchema = Joi.object({
  provider: Joi.string().trim().min(2).max(40).pattern(/^[A-Za-z0-9_-]+$/).required()
});

/**
 * Where a restaurant is paid.
 *
 * All four together or none, matching the database constraint: a half-filled
 * payee looks configured on screen and cannot receive money, and that failure
 * lands on a diner holding a phone rather than on whoever filled the form in.
 */
const payoutSchema = Joi.object({
  bankCode: Joi.string().trim().pattern(/^[0-9]{4}$/)
    .valid(...banks.CODES)
    .messages({ 'any.only': 'bankCode must be a known Venezuelan bank code' }),
  accountNumber: Joi.string().trim().pattern(/^[0-9]{20}$/),
  // The phone the Pago Móvil is registered to. Same loose validation as the
  // onboarding form, and for the same reason -- one line gets written three
  // ways -- but normalised to digits before storage so it can be compared.
  phone: Joi.string().trim().min(7).max(20).pattern(/^[+()\-.\s\d]+$/),
  // Cédula or RIF of the account holder. V/E/J/P/G then 6 to 9 digits, which
  // covers both: a cédula is not a RIF and this field takes either.
  holderId: Joi.string().trim().uppercase().pattern(/^[VEJPG][0-9]{6,9}$/)
    .messages({ 'string.pattern.base': 'holderId must be a cédula or RIF, e.g. V12345678 or J123456789' })
})
  .and('bankCode', 'accountNumber', 'phone', 'holderId')
  // Read once here so a wrong bank in the picker is caught at the door rather
  // than by a CHECK, which would surface as a 500 with no useful field name.
  .custom((value, helpers) => {
    if (value.accountNumber && value.bankCode
        && banks.bankOfAccount(value.accountNumber) !== value.bankCode) {
      return helpers.message(
        'accountNumber does not belong to that bank: a Venezuelan account number starts with its own four-digit bank code'
      );
    }
    return value;
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

/**
 * What the restaurant tells us about itself on the registration form.
 *
 * Every field is optional. These are qualifying questions, and a required
 * qualifying question is a field somebody types "n/a" into -- which is worse
 * than an absent one, because it looks like an answer. `notes` is the free box;
 * the named fields exist so the common answers arrive as data rather than as
 * prose somebody has to read.
 */
const signupProfileSchema = Joi.object({
  tableCount: Joi.number().integer().min(1).max(1000),
  staffCount: Joi.number().integer().min(1).max(2000),
  // Whatever they run today: a POS name, "cuaderno", "Excel". Free text because
  // an enum here would be a list of the systems we already thought of, and the
  // interesting answers are the ones we did not.
  posSystem: Joi.string().trim().max(120).allow(''),
  monthlyCovers: Joi.number().integer().min(0).max(1000000),
  notes: Joi.string().trim().max(2000).allow('')
}).default({});

const onboardingSignupSchema = Joi.object({
  restaurantName: Joi.string().trim().min(2).max(120).required(),
  // Accepted in any spelling -- J-12345678-9, j123456789 -- and normalised by
  // the service before it is stored or compared. Validating the normalised
  // shape here rather than the typed one keeps the form from rejecting a RIF
  // over where somebody put the dashes.
  rif: Joi.string().trim().max(20).custom((value, helpers) => {
    const normalised = normaliseRif(value);
    return hasRifShape(normalised) ? normalised : helpers.error('any.invalid');
  }, 'RIF shape').required(),
  email: Joi.string().email({ minDomainSegments: 2 }).max(254).lowercase().required(),
  // Required, because the next thing that happens to this lead is that somebody
  // telephones it. A lead with no number cannot be worked, and making the field
  // optional only moves the problem to the reviewer.
  //
  // Deliberately loose: digits, spaces and the usual punctuation, 7 to 20
  // characters. Venezuelan numbers are written +58 412 1234567, 0412-1234567
  // and 04121234567 by different people meaning the same line, and a form that
  // rejects two of those spellings loses the restaurant rather than teaching it
  // ours.
  phone: Joi.string().trim().min(7).max(40).pattern(/^[+()\-.\s\d]+$/).required(),
  // The menu currency the restaurant quotes in. Changeable afterwards, but only
  // while the menu is empty, so asking now saves a support conversation.
  menuCurrency: Joi.string().valid(...MENU_CURRENCIES).default('VES'),
  profile: signupProfileSchema
});

/**
 * Verification, which is also where the password is set for the first time.
 *
 * Deliberately not collected at signup. A password submitted before the address
 * is proven is a credential stored against an unverified row, and it makes the
 * public endpoint run Argon2id -- 19 MiB per call by ARGON2_OPTIONS -- for
 * anyone who can reach it.
 */
const onboardingVerifySchema = Joi.object({
  token: Joi.string().trim().min(20).max(512).required(),
  password: Joi.string().min(12).max(128).required()
});

// Basis points, so no float touches a rate. 1600 = 16%, 1000 = 10%.
// Both optional, but at least one has to be present or the call does nothing.
const menuChargesSchema = Joi.object({
  vatBps: Joi.number().integer().min(0).max(10000),
  serviceChargeBps: Joi.number().integer().min(0).max(10000)
}).min(1);

// Permanent removal is opt-in. The default stays a soft deactivate, because
// that is the safe thing to do to something a bill might reference.
const deleteProductQuerySchema = Joi.object({
  permanent: Joi.boolean().default(false)
});

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
  onboardingSignupSchema,
  onboardingVerifySchema,
  signupProfileSchema,
  splitPaymentSchema,
  payoutSchema,
  declareClaimSchema,
  listClaimsQuerySchema,
  rejectClaimSchema,
  paymentIdParamSchema,
  webhookProviderParamSchema,
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
  menuChargesSchema,
  deleteProductQuerySchema,
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
