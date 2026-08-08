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

const splitPaymentSchema = Joi.object({
  billId: uuid.required(),
  // Minor units only. Capped below Number.MAX_SAFE_INTEGER so arithmetic in
  // the payment path can never silently lose precision.
  amountMinorUnits: Joi.number().integer().positive().max(Number.MAX_SAFE_INTEGER).required(),
  currency: Joi.string().valid('VES', 'USD', 'USDT').required(),
  idempotencyKey: Joi.string().trim().min(16).max(128).pattern(/^[A-Za-z0-9._:-]+$/).required()
});

const billIdParamSchema = Joi.object({ id: uuid.required() });
const tableIdParamSchema = Joi.object({ tableId: uuid.required() });

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

module.exports = {
  registerSchema,
  loginSchema,
  refreshSchema,
  guestSessionSchema,
  splitPaymentSchema,
  billIdParamSchema,
  tableIdParamSchema,
  validate,
  validateBody,
  validateParams
};
