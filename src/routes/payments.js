const express = require('express');
const claims = require('../services/paymentClaims');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { auditContext } = require('../services/audit');
const dto = require('../dto');
const {
  validateBody, validateParams, validateQuery,
  listClaimsQuerySchema, rejectClaimSchema, paymentIdParamSchema
} = require('../middleware/schemas');

/**
 * The staff side of declared payments.
 *
 * A diner declares a Pago Móvil from the guest app; nothing moves. These are
 * the endpoints where a person who can see the restaurant's bank app turns that
 * declaration into a settled bill, or says they cannot find the money.
 *
 * Confirming is restricted to roles that are accountable for the till. A waiter
 * can take an order; deciding that money arrived is a cashier's job upwards.
 */
const router = express.Router();
router.use(authenticateToken);

router.get('/claims', validateQuery(listClaimsQuerySchema), async (req, res, next) => {
  try {
    const rows = await claims.listClaims({
      restaurantId: req.user.restaurantId,
      billId: req.query.billId ?? null,
      status: req.query.status ?? 'PENDING',
      limit: req.query.limit
    });
    res.json({ data: rows.map(dto.staffPaymentClaim) });
  } catch (err) { next(err); }
});

router.post(
  '/claims/:id/confirm',
  requireRole('OWNER', 'MANAGER', 'CASHIER'),
  validateParams(paymentIdParamSchema),
  async (req, res, next) => {
    try {
      const result = await claims.confirmClaim({
        restaurantId: req.user.restaurantId,
        claimId: req.params.id,
        actor: { id: req.user.sub },
        meta: auditContext(req)
      });
      res.json(result);
    } catch (err) { next(err); }
  }
);

router.post(
  '/claims/:id/reject',
  requireRole('OWNER', 'MANAGER', 'CASHIER'),
  validateParams(paymentIdParamSchema),
  validateBody(rejectClaimSchema),
  async (req, res, next) => {
    try {
      const claim = await claims.rejectClaim({
        restaurantId: req.user.restaurantId,
        claimId: req.params.id,
        reason: req.body.reason ?? null,
        actor: { id: req.user.sub },
        meta: auditContext(req)
      });
      res.json(dto.staffPaymentClaim(claim));
    } catch (err) { next(err); }
  }
);

module.exports = router;
