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
  addBillItemSchema,
  updateBillItemSchema,
  billItemIdParamSchema,
  listBillsQuerySchema,
  splitQuerySchema,
  billIdParamSchema,
  tableIdParamSchema
} = require('../middleware/schemas');
const { processSplitPayment } = require('../services/locks');
const billItems = require('../services/billItems');
const { getRateFor } = require('../services/fx');
const { splitEvenly, usdReference } = require('../services/split');
const dto = require('../dto');
const { ApiError } = require('../errors');
const { parseRate, applyRate, toMinor } = require('../services/money');
const { requestHash, begin, complete, abort } = require('../services/idempotency');
const { logAudit, auditContext } = require('../services/audit');
const { logger } = require('../connectors/logger');

const router = express.Router();

// total_due and currency are what the menu quoted; total_due_ves and
// amount_paid_ves are what Splite settles. The rate is frozen at bill creation.
const BILL_COLUMNS = `id, restaurant_id, table_id, status,
                      total_due, currency,
                      total_due_ves, amount_paid_ves,
                      fx_rate_ves_per_unit, fx_rate_source, fx_value_date,
                      calculation_version, created_at, updated_at`;

router.use(authenticateToken);

// Mounted *after* authentication so the bucket keys on req.user.sub. The
// app-level limiter runs before any auth middleware, which leaves it keyed on
// IP alone — behind carrier NAT that is one shared bucket for many staff.
router.use(rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'bills' }));

/**
 * Freezes the rate the bill will settle at.
 *
 * Taken when the bill is opened, not when it is first paid, so the total a
 * diner is quoted cannot move underneath them while they eat. A VES menu needs
 * no conversion and is recorded as an identity rate rather than a null, so
 * every bill can state what it settled at.
 */
async function snapshotFx(menuCurrency, totalDueMinorUnits) {
  if (menuCurrency === 'VES') {
    return { totalDueVes: String(totalDueMinorUnits), rate: '1', source: 'IDENTITY', valueDate: null };
  }

  const fx = await getRateFor(menuCurrency);
  if (!fx) {
    // Fail closed: a foreign-currency bill without a rate has no settleable
    // total, and inventing one is what the FX service exists to prevent. This
    // can only stop a bill being opened; payments on existing bills use the
    // rate already frozen on them.
    throw new ApiError(
      'FX_UNAVAILABLE',
      `No exchange rate is available for ${menuCurrency}, so the bill cannot be opened`,
      { currency: menuCurrency }
    );
  }

  const scaled = parseRate(fx.rate);
  return {
    totalDueVes: applyRate(toMinor(totalDueMinorUnits), scaled, 'Bill total in VES').toString(),
    rate: String(fx.rate),
    source: fx.source,
    valueDate: fx.valueDate ?? null
  };
}

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

    res.json({ data: rows.map(dto.bill), limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

/**
 * The current open bill for a table.
 *
 * A physical table QR is permanent, so a client that scans it needs a way to
 * resolve "which bill is this table on right now". The one-open-bill invariant
 * is what makes that answer unambiguous.
 */
router.get('/tables/:tableId/open', validateParams(tableIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${BILL_COLUMNS} FROM bills
        WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'`,
      [req.user.restaurantId, req.params.tableId]
    );
    if (!rows.length) throw new ApiError('OPEN_BILL_NOT_FOUND', 'No open bill for this table');

    res.json(dto.bill(rows[0]));
  } catch (err) { next(err); }
});

router.post(
  '/',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateBody(createBillSchema),
  async (req, res, next) => {
    try {
      // Everything that can touch the network happens before BEGIN.
      //
      // snapshotFx may fetch from BCV, and this used to run inside the
      // transaction, after the table row was locked: an 8-second upstream
      // stalled every other request for that table, held a pooled connection,
      // and left the transaction idle long enough for
      // idle_in_transaction_session_timeout to terminate the session outright.
      //
      // Reading menu_currency outside the transaction means it could change
      // between here and the insert. That race is benign — the bill would use
      // a currency that was correct moments earlier — and changing it is
      // already refused while any active product disagrees.
      const restaurant = await db.query(
        'SELECT menu_currency FROM restaurants WHERE id = $1',
        [req.user.restaurantId]
      );
      const menuCurrency = restaurant.rows[0]?.menu_currency ?? 'VES';
      const fx = await snapshotFx(menuCurrency, req.body.totalDueMinorUnits);

      const created = await db.withTransaction(async client => {
        // The table row is locked for the duration, so two waiters opening a
        // bill for the same table serialise here instead of racing between the
        // check below and the insert.
        //
        // It is also resolved inside the caller's tenant, so a table id
        // belonging to another restaurant reads as 404 rather than creating a
        // bill that points across tenants.
        const table = await client.query(
          'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true FOR UPDATE',
          [req.body.tableId, req.user.restaurantId]
        );
        if (!table.rows.length) {
          throw new ApiError('TABLE_NOT_FOUND', 'Table not found');
        }

        const open = await client.query(
          "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
          [req.user.restaurantId, req.body.tableId]
        );
        if (open.rows.length) {
          throw new ApiError('OPEN_BILL_EXISTS', 'This table already has an open bill', {
            billId: open.rows[0].id
          });
        }

        // The bill is denominated in whatever the menu quotes, at the rate
        // frozen above, before this transaction opened.
        const { rows } = await client.query(
          `INSERT INTO bills (restaurant_id, table_id, total_due, currency,
                              total_due_ves, fx_rate_ves_per_unit, fx_rate_source,
                              fx_value_date, fx_rate_as_of)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           RETURNING ${BILL_COLUMNS}`,
          [
            req.user.restaurantId, req.body.tableId, req.body.totalDueMinorUnits, menuCurrency,
            fx.totalDueVes, fx.rate, fx.source, fx.valueDate
          ]
        );
        return rows[0];
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_CREATED',
        resourceType: 'bill',
        resourceId: created.id,
        details: {
          tableId: req.body.tableId,
          totalDue: created.total_due,
          currency: created.currency,
          totalDueVes: created.total_due_ves
        }
      });

      res.status(201).json(dto.bill(created));
    } catch (err) {
      // The partial unique index is the last line of defence: if a concurrent
      // request committed first, the insert fails here rather than producing a
      // second open bill for the table.
      if (err.code === '23505' && String(err.constraint || '').includes('one_open_per_table')) {
        return next(new ApiError('OPEN_BILL_EXISTS', 'This table already has an open bill'));
      }
      next(err);
    }
  }
);

router.get('/:id', validateParams(billIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${BILL_COLUMNS} FROM bills WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

    // A single bill always carries its lines, so a client never has to make a
    // second call to render one. The list endpoint deliberately does not.
    const items = await billItems.listForBill({
      restaurantId: req.user.restaurantId, billId: req.params.id
    });
    res.json(dto.billWithItems(rows[0], items));
  } catch (err) { next(err); }
});

/**
 * Line items.
 *
 * A line's price is snapshotted when it is added, so re-pricing the menu never
 * changes a bill that has already been served. Every mutation recomputes the
 * bill total from its lines and re-converts at the rate frozen when the bill
 * opened -- never at today's rate, or adding a coffee would reprice the meal.
 */
router.get('/:id/items', validateParams(billIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM bills WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

    const items = await billItems.listForBill({
      restaurantId: req.user.restaurantId, billId: req.params.id
    });
    res.json({ data: items.map(dto.billItem) });
  } catch (err) { next(err); }
});

router.post(
  '/:id/items',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billIdParamSchema),
  validateBody(addBillItemSchema),
  async (req, res, next) => {
    try {
      const { item, bill } = await billItems.addItem({
        restaurantId: req.user.restaurantId,
        billId: req.params.id,
        productId: req.body.productId,
        quantity: req.body.quantity
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_ITEM_ADDED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { itemId: item.id, productId: req.body.productId, quantity: item.quantity }
      });

      res.status(201).json({ item: dto.billItem(item), bill: dto.bill(bill) });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/:id/items/:itemId',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billItemIdParamSchema),
  validateBody(updateBillItemSchema),
  async (req, res, next) => {
    try {
      const { item, bill } = await billItems.updateQuantity({
        restaurantId: req.user.restaurantId,
        billId: req.params.id,
        itemId: req.params.itemId,
        quantity: req.body.quantity
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_ITEM_UPDATED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { itemId: item.id, quantity: item.quantity }
      });

      res.json({ item: dto.billItem(item), bill: dto.bill(bill) });
    } catch (err) { next(err); }
  }
);

router.delete(
  '/:id/items/:itemId',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billItemIdParamSchema),
  async (req, res, next) => {
    try {
      const { removedId, bill } = await billItems.removeItem({
        restaurantId: req.user.restaurantId,
        billId: req.params.id,
        itemId: req.params.itemId
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_ITEM_REMOVED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { itemId: removedId }
      });

      res.json({ removedId, bill: dto.bill(bill) });
    } catch (err) { next(err); }
  }
);

/** Suggested even split of the outstanding balance, exact to the céntimo. */
router.get(
  '/:id/split',
  validateParams(billIdParamSchema),
  validateQuery(splitQuerySchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT total_due_ves, amount_paid_ves, fx_rate_ves_per_unit FROM bills WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

      const outstanding = (BigInt(rows[0].total_due_ves) - BigInt(rows[0].amount_paid_ves)).toString();
      const shares = splitEvenly(outstanding, req.query.diners);

      res.json({
        currency: 'VES',
        outstanding,
        diners: req.query.diners,
        shares,
        usdReference: shares.map(share => usdReference(share, rows[0].fx_rate_ves_per_unit))
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
          WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN' AND amount_paid_ves = 0
        RETURNING ${BILL_COLUMNS}`,
        [req.params.id, req.user.restaurantId]
      );

      if (!rows.length) {
        const existing = await db.query(
          'SELECT status, amount_paid_ves FROM bills WHERE id = $1 AND restaurant_id = $2',
          [req.params.id, req.user.restaurantId]
        );
        if (!existing.rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
        throw existing.rows[0].amount_paid_ves !== '0'
          ? new ApiError('BILL_HAS_PAYMENTS', 'A bill with payments applied cannot be voided')
          : new ApiError('BILL_NOT_OPEN', `A ${existing.rows[0].status} bill cannot be voided`, {
            status: existing.rows[0].status
          });
      }

      await logAudit({
        ...auditContext(req),
        action: 'BILL_VOIDED',
        resourceType: 'bill',
        resourceId: rows[0].id
      });

      // Through the same mapper as every other bill response. This route used
      // to return the raw row, so a voided bill came back in a different shape
      // than the one that had just been read — both documented as `Bill`.
      res.json(dto.bill(rows[0]));
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
      return next(new ApiError('BILL_ID_MISMATCH', 'billId does not match the URL'));
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
        // Recorded on the ledger row so a payment can be traced back to the
        // request and the person who took it.
        idempotencyKey: key,
        payer: { type: 'STAFF', id: req.user.sub }
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
          logger.error({ event: 'IDEMPOTENCY_ABORT_FAILED', billId: req.params.id, err: abortErr }, 'Idempotency abort failed');
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
