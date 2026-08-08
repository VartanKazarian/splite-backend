const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateBody, validateParams, splitPaymentSchema, billIdParamSchema } = require('../middleware/schemas');
const { processSplitPayment } = require('../services/locks');
const { requestHash, begin, complete, abort } = require('../services/idempotency');
const { logAudit, auditContext } = require('../services/audit');

const router = express.Router();

router.get('/:id', authenticateToken, validateParams(billIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, restaurant_id, table_id, total_due, amount_paid, currency, status, created_at, updated_at
         FROM bills
        WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.user.restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bill not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post(
  '/:id/payments',
  authenticateToken,
  requireRole('OWNER', 'MANAGER', 'CASHIER'),
  validateParams(billIdParamSchema),
  validateBody(splitPaymentSchema),
  async (req, res, next) => {
    if (req.body.billId !== req.params.id) {
      return res.status(400).json({ error: 'billId does not match the URL' });
    }

    const key = req.get('Idempotency-Key') || req.body.idempotencyKey;
    const restaurantId = req.user.restaurantId;
    let claimed = false;

    try {
      const idem = await begin({ restaurantId, userId: req.user.sub, key, hash: requestHash(req) });
      if (!idem.owner) return res.status(idem.response.status).json(idem.response.body);
      claimed = true;

      const result = await processSplitPayment({
        restaurantId,
        billId: req.params.id,
        amountPaidMinorUnits: req.body.amountMinorUnits,
        currency: req.body.currency
      });

      // Store the response before replying, so a client retry that races the
      // response replays the stored result instead of double-charging.
      await complete({ restaurantId, key, status: 200, body: result });

      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_APPLIED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { amountMinorUnits: req.body.amountMinorUnits, currency: req.body.currency, status: result.status }
      });

      res.json(result);
    } catch (err) {
      // Release the claim only if this request owns it; a 409 from begin()
      // belongs to somebody else's in-flight request.
      if (claimed) {
        try { await abort({ restaurantId, key }); } catch (abortErr) {
          console.error('[Idempotency abort]', abortErr.message);
        }
      }
      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_FAILED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { reason: err.message, status: err.statusCode || 500 }
      });
      next(err);
    }
  }
);

module.exports = router;
