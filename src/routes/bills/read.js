/** Reading bills: the list, the open bill of a table, one bill and its lines. */
const express = require('express');
const db = require('../../connectors/base');
const {
  validateParams,
  validateQuery,
  listBillsQuerySchema,
  billIdParamSchema,
  tableIdParamSchema
} = require('../../middleware/schemas');
const billItems = require('../../services/billItems');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const { BILL_COLUMNS } = require('../../services/bills');

const router = express.Router();

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

module.exports = router;
