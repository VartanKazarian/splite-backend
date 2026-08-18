const express = require('express');
const claims = require('../services/paymentClaims');
const mercantilC2P = require('../services/mercantilC2P');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { logAudit, auditContext } = require('../services/audit');
const dto = require('../dto');
const {
  validateBody, validateParams, validateQuery,
  listClaimsQuerySchema, rejectClaimSchema, paymentIdParamSchema,
  listUnresolvedC2PQuerySchema
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

/**
 * C2P charges that reached no settled state.
 *
 * IN_DOUBT: the bank never told us what happened. AMBIGUOUS: it has money that
 * matches and nothing ties it to this diner, or it confirmed a debit that could
 * not be credited to the bill.
 *
 * This endpoint is what makes the honest answer usable. A resolver that refuses
 * to guess produces charges nobody is looking at unless there is a queue, and a
 * charge nobody is looking at is indistinguishable from one that was lost --
 * which is how "never guess" quietly turns into "silently drop".
 */
router.get('/c2p/unresolved', validateQuery(listUnresolvedC2PQuerySchema), async (req, res, next) => {
  try {
    const rows = await mercantilC2P.listUnresolved({
      restaurantId: req.user.restaurantId,
      limit: req.query.limit
    });
    res.json({ data: rows.map(dto.c2pCharge) });
  } catch (err) { next(err); }
});

/**
 * Ask Mercantil what actually happened to an in-doubt charge.
 *
 * Restricted like claim confirmation and for the same reason: this can settle a
 * bill, so it is a cashier's job upwards.
 *
 * It settles only when a bank movement matches on both amount and the payer's
 * phone. Matching on amount alone is what would settle one table with another
 * table's money, so a movement it cannot attribute moves the charge to
 * AMBIGUOUS with the candidate references attached rather than guessing between
 * them. Re-running an AMBIGUOUS charge returns it unchanged: the system has
 * already said it cannot tell, and asking again will not change that.
 */
router.post(
  '/c2p/:id/resolve',
  requireRole('OWNER', 'MANAGER', 'CASHIER'),
  validateParams(paymentIdParamSchema),
  async (req, res, next) => {
    try {
      const result = await mercantilC2P.resolveC2PPayment({
        restaurantId: req.user.restaurantId,
        paymentId: req.params.id,
        actorUserId: req.user.sub
      });

      await logAudit({
        ...auditContext(req),
        action: 'C2P_RESOLUTION_ATTEMPTED',
        resourceType: 'payment',
        resourceId: req.params.id,
        details: { status: result.status }
      });

      res.json(result);
    } catch (err) { next(err); }
  }
);

module.exports = router;
