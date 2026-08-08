const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const {
  validateBody,
  validateParams,
  validateQuery,
  splitPaymentSchema,
  createBillSchema,
  listBillsQuerySchema,
  splitQuerySchema,
  billIdParamSchema
} = require('../middleware/schemas');
const { processSplitPayment } = require('../services/locks');
const { getUsdToVesRate } = require('../services/fx');
const { splitEvenly, usdReference } = require('../services/split');
const { requestHash, begin, complete, abort } = require('../services/idempotency');
const { logAudit, auditContext } = require('../services/audit');

const router = express.Router();

const BILL_COLUMNS = `id, restaurant_id, table_id, total_due, amount_paid, currency, status,
                      fx_rate, fx_source, fx_locked_at, created_at, updated_at`;

router.use(authenticateToken);

// Mounted *after* authentication so the bucket keys on req.user.sub. The
// app-level limiter runs before any auth middleware, which leaves it keyed on
// IP alone — behind carrier NAT that is one shared bucket for many staff.
router.use(rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'bills' }));

router.get('/', validateQuery(listBillsQuerySchema), async (req, res, next) => {
  try {
    const params = [req.user.restaurantId];
    let where = 'restaurant_id = $1';

    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND status = $${params.length}`;
    }
    if (req.query.tableId) {
      params.push(req.query.tableId);
      where += ` AND table_id = $${params.length}`;
    }

    params.push(req.query.limit, req.query.offset);
    const { rows } = await db.query(
      `SELECT ${BILL_COLUMNS} FROM bills
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows, limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

router.post(
  '/',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateBody(createBillSchema),
  async (req, res, next) => {
    try {
      // The table is resolved inside the caller's tenant, so a table id
      // belonging to another restaurant reads as 404 rather than creating a
      // bill that points across tenants.
      const table = await db.query(
        'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true',
        [req.body.tableId, req.user.restaurantId]
      );
      if (!table.rows.length) return res.status(404).json({ error: 'Table not found' });

      // Currency is fixed at VES; migration 003 enforces the same rule with a
      // CHECK constraint.
      const { rows } = await db.query(
        `INSERT INTO bills (restaurant_id, table_id, total_due, currency)
         VALUES ($1, $2, $3, 'VES')
         RETURNING ${BILL_COLUMNS}`,
        [req.user.restaurantId, req.body.tableId, req.body.totalDueMinorUnits]
      );

      await logAudit({
        ...auditContext(req),
        action: 'BILL_CREATED',
        resourceType: 'bill',
        resourceId: rows[0].id,
        details: { tableId: req.body.tableId, totalDue: rows[0].total_due }
      });

      res.status(201).json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get('/:id', validateParams(billIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.user.restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bill not found' });

    const bill = rows[0];
    const remaining = (BigInt(bill.total_due) - BigInt(bill.amount_paid)).toString();
    res.json({
      ...bill,
      remaining,
      // Presentational only; null until a rate is locked on the first payment.
      usdReference: {
        totalDue: usdReference(bill.total_due, bill.fx_rate),
        amountPaid: usdReference(bill.amount_paid, bill.fx_rate),
        remaining: usdReference(remaining, bill.fx_rate)
      }
    });
  } catch (err) { next(err); }
});

/** Suggested even split of the outstanding balance, exact to the céntimo. */
router.get(
  '/:id/split',
  validateParams(billIdParamSchema),
  validateQuery(splitQuerySchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT total_due, amount_paid, fx_rate FROM bills WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Bill not found' });

      const outstanding = (BigInt(rows[0].total_due) - BigInt(rows[0].amount_paid)).toString();
      const shares = splitEvenly(outstanding, req.query.diners);

      res.json({
        currency: 'VES',
        outstanding,
        diners: req.query.diners,
        shares,
        usdReference: shares.map(share => usdReference(share, rows[0].fx_rate))
      });
    } catch (err) { next(err); }
  }
);

/**
 * Voids a bill that nobody has paid into.
 *
 * A bill carrying payments is deliberately not voidable: money has moved, and
 * reversing it is a refund, not a status change.
 */
router.post(
  '/:id/void',
  requireRole('OWNER', 'MANAGER'),
  validateParams(billIdParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE bills
            SET status = 'VOID'
          WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN' AND amount_paid = 0
        RETURNING ${BILL_COLUMNS}`,
        [req.params.id, req.user.restaurantId]
      );

      if (!rows.length) {
        const existing = await db.query(
          'SELECT status, amount_paid FROM bills WHERE id = $1 AND restaurant_id = $2',
          [req.params.id, req.user.restaurantId]
        );
        if (!existing.rows.length) return res.status(404).json({ error: 'Bill not found' });
        return res.status(409).json({
          error: existing.rows[0].amount_paid !== '0'
            ? 'A bill with payments applied cannot be voided'
            : `A ${existing.rows[0].status} bill cannot be voided`
        });
      }

      await logAudit({
        ...auditContext(req),
        action: 'BILL_VOIDED',
        resourceType: 'bill',
        resourceId: rows[0].id
      });

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/payments',
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
        // Presentational: resolved only when this bill has no locked rate yet,
        // and never permitted to block settlement.
        getRate: getUsdToVesRate
      });

      // Store the response before replying, so a client retry that races the
      // response replays the stored result instead of double-charging.
      await complete({ restaurantId, key, status: 200, body: result });

      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_APPLIED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { amountMinorUnits: req.body.amountMinorUnits, currency: 'VES', status: result.status }
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
