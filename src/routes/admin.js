const express = require('express');

const {
  validateBody, validateParams, validateQuery,
  operatorLoginSchema, operatorSetupStartSchema, operatorSetupCompleteSchema,
  adminRestaurantParamSchema, adminChargeParamSchema, adminClientsQuerySchema, adminPlanSchema,
  adminSubscriptionSchema, adminChargeSchema, adminVoidChargeSchema, adminPaymentSchema,
  adminChargesQuerySchema, adminPriceSchema
} = require('../middleware/schemas');
const { authenticateOperator, requireOperatorRole } = require('../middleware/operatorAuth');
const { auditContext } = require('../services/audit');
const operators = require('../services/operators');
const billing = require('../services/platformBilling');

/**
 * La consola de Splite: clientes, planes, cargos y pagos.
 *
 * Nada de aquí sirve a un restaurante ni acepta su sesión. Mirar es de ADMIN y
 * SUPPORT; cambiar algo, sólo de ADMIN, y todo cambio queda en
 * `operator_audit` con quién, cuándo y desde dónde.
 */
const router = express.Router();

const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };
router.use(noStore);

router.post('/auth/login', validateBody(operatorLoginSchema), async (req, res, next) => {
  try {
    res.json(await operators.login({ ...req.body, meta: auditContext(req) }));
  } catch (err) { next(err); }
});

router.post('/auth/setup/start', validateBody(operatorSetupStartSchema), async (req, res, next) => {
  try {
    res.json(await operators.setupStart({ token: req.body.token }));
  } catch (err) { next(err); }
});

router.post('/auth/setup/complete', validateBody(operatorSetupCompleteSchema), async (req, res, next) => {
  try {
    res.json(await operators.setupComplete({ ...req.body, meta: auditContext(req) }));
  } catch (err) { next(err); }
});

router.use(authenticateOperator);
const admin = requireOperatorRole('ADMIN');
const anyone = requireOperatorRole('ADMIN', 'SUPPORT');
const meta = req => auditContext(req);

router.get('/me', anyone, (req, res) => {
  res.json({ operator: { id: res.locals.operator.id, email: res.locals.operator.email, displayName: res.locals.operator.displayName, role: res.locals.operator.role } });
});

router.get('/clients', anyone, validateQuery(adminClientsQuerySchema), async (req, res, next) => {
  try {
    res.json(await billing.listClients({ q: req.query.q || null, state: req.query.state || null }));
  } catch (err) { next(err); }
});

router.get('/clients/:restaurantId', anyone, validateParams(adminRestaurantParamSchema), async (req, res, next) => {
  try {
    res.json(await billing.getClient(req.params.restaurantId));
  } catch (err) { next(err); }
});

router.patch(
  '/clients/:restaurantId/plan', admin, validateParams(adminRestaurantParamSchema), validateBody(adminPlanSchema),
  async (req, res, next) => {
    try {
      const { after, changes } = await billing.changePlan({
        operator: res.locals.operator, restaurantId: req.params.restaurantId,
        tier: req.body.tier, trialDays: req.body.trialDays ?? null, force: req.body.force,
        note: req.body.note || null, meta: meta(req)
      });
      res.json({ tier: after.plan_tier, trialEndsAt: after.trial_ends_at ? new Date(after.trial_ends_at).toISOString() : null, gained: changes.gained, lost: changes.lost });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/clients/:restaurantId/subscription', admin, validateParams(adminRestaurantParamSchema),
  validateBody(adminSubscriptionSchema),
  async (req, res, next) => {
    try {
      const changes = { ...req.body };
      if (changes.notes === '') changes.notes = null;
      res.json(await billing.updateSubscription({
        operator: res.locals.operator, restaurantId: req.params.restaurantId, changes, meta: meta(req)
      }));
    } catch (err) { next(err); }
  }
);

router.post(
  '/clients/:restaurantId/charges', admin, validateParams(adminRestaurantParamSchema), validateBody(adminChargeSchema),
  async (req, res, next) => {
    try {
      const charge = await billing.createCharge({
        operator: res.locals.operator, restaurantId: req.params.restaurantId,
        periodStart: req.body.periodStart ?? null, meta: meta(req)
      });
      res.status(201).json({ charge });
    } catch (err) { next(err); }
  }
);

router.post(
  '/clients/:restaurantId/payments', admin, validateParams(adminRestaurantParamSchema), validateBody(adminPaymentSchema),
  async (req, res, next) => {
    try {
      const input = { ...req.body, reference: req.body.reference || null, notes: req.body.notes || null };
      const result = await billing.recordPayment({
        operator: res.locals.operator, restaurantId: req.params.restaurantId, input, meta: meta(req)
      });
      res.status(201).json(result);
    } catch (err) { next(err); }
  }
);

router.get('/charges', anyone, validateQuery(adminChargesQuerySchema), async (req, res, next) => {
  try {
    res.json({ data: await billing.listCharges({ status: req.query.status || null }) });
  } catch (err) { next(err); }
});

router.post(
  '/charges/:chargeId/void', admin, validateParams(adminChargeParamSchema), validateBody(adminVoidChargeSchema),
  async (req, res, next) => {
    try {
      res.json({ charge: await billing.voidCharge({ operator: res.locals.operator, chargeId: req.params.chargeId, reason: req.body.reason, meta: meta(req) }) });
    } catch (err) { next(err); }
  }
);

router.get('/prices', anyone, async (req, res, next) => {
  try {
    res.json(await billing.listPrices());
  } catch (err) { next(err); }
});

router.post('/prices', admin, validateBody(adminPriceSchema), async (req, res, next) => {
  try {
    const price = await billing.addPrice({
      operator: res.locals.operator, tier: req.body.tier, billingCycle: req.body.billingCycle,
      amountUsd: req.body.amountUsd, effectiveFrom: req.body.effectiveFrom ?? null, meta: meta(req)
    });
    res.status(201).json({ price });
  } catch (err) { next(err); }
});

module.exports = router;
