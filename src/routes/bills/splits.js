/** Splitting a bill: preview, the agreed split, voiding it. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const {
  validateBody,
  validateParams,
  splitPreviewSchema,
  splitIdParamSchema,
  billIdParamSchema
} = require('../../middleware/schemas');
const billItems = require('../../services/billItems');
const splitEngine = require('../../services/splitEngine');
const splits = require('../../services/splits');
const dto = require('../../dto');
const { ApiError } = require('../../errors');

const router = express.Router();

/**
 * Computes an exact split of the outstanding balance.
 *
 * Advisory: it reads and returns, and mutates nothing. Payment still goes
 * through POST /payments, which takes the row lock and enforces the ceiling.
 *
 * POST rather than GET because the intent -- participants, claims, custom
 * amounts -- does not fit in a query string, not because anything is written.
 */
router.post(
  '/:id/split/preview',
  validateParams(billIdParamSchema),
  validateBody(splitPreviewSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT id, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit
           FROM bills WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

      // Lines are only read for ITEMS; fetching them unconditionally would put
      // a query on every EQUAL split for nothing.
      const items = req.body.mode === 'ITEMS'
        ? await billItems.listForBill({ restaurantId: req.user.restaurantId, billId: req.params.id })
        : [];

      res.json(splitEngine.preview({ bill: rows[0], items, request: req.body }));
    } catch (err) { next(err); }
  }
);

/**
 * Agrees a persistent split of the bill's outstanding balance.
 *
 * The advisory preview computes the same numbers and moves on; this stores them,
 * so a group settles against one agreed plan from several phones. The shares sum
 * to the outstanding balance by construction, and the database refuses a split
 * that does not (migration 020). One live split per bill: void the current one
 * before agreeing another.
 */
router.post(
  '/:id/splits',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billIdParamSchema),
  validateBody(splitPreviewSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        // `status` is read so createSplit can refuse a bill that is not open.
        // It used to be left out of this list entirely, which is why nothing
        // downstream could check it.
        `SELECT id, status, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit
           FROM bills WHERE id = $1 AND restaurant_id = $2`,
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

      const items = req.body.mode === 'ITEMS'
        ? await billItems.listForBill({ restaurantId: req.user.restaurantId, billId: req.params.id })
        : [];

      const split = await splits.createSplit({
        restaurantId: req.user.restaurantId,
        bill: rows[0],
        items,
        request: req.body,
        createdBy: { type: 'STAFF', id: req.user.sub }
      });
      res.status(201).json(dto.billSplit(split));
    } catch (err) { next(err); }
  }
);

/** The bill's live split, or 404 if there is none. */
router.get(
  '/:id/splits/active',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billIdParamSchema),
  async (req, res, next) => {
    try {
      const split = await splits.getActiveSplit({ restaurantId: req.user.restaurantId, billId: req.params.id });
      if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'This bill has no active split');
      res.json(dto.billSplit(split));
    } catch (err) { next(err); }
  }
);

/**
 * Voids a split. Refused once any share has been paid into -- a plan people
 * have started settling against is a record, not a draft.
 */
router.post(
  '/:id/splits/:splitId/void',
  requireRole('OWNER', 'MANAGER', 'CASHIER'),
  validateParams(splitIdParamSchema),
  async (req, res, next) => {
    try {
      const split = await splits.voidSplit({
        restaurantId: req.user.restaurantId,
        // The path says this split is on this bill; the service checks it.
        billId: req.params.id,
        splitId: req.params.splitId,
        actor: { id: req.user.sub }
      });
      res.json(dto.billSplit(split));
    } catch (err) { next(err); }
  }
);

module.exports = router;
