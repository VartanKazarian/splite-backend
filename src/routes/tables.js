const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody,
  validateParams,
  validateQuery,
  createTableSchema,
  bulkTablesSchema,
  updateTableSchema,
  listTablesQuerySchema,
  tableIdParamSchema
} = require('../middleware/schemas');
const { logAudit, auditContext } = require('../services/audit');
const dto = require('../dto');
const { ApiError } = require('../errors');

const router = express.Router();

// Applied at router level so a future route cannot be added without it.
router.use(authenticateToken);

// qr_nonce is deliberately never returned: it is signing input for QR tokens,
// and nothing outside src/routes/guest.js has any reason to see it.
const TABLE_COLUMNS = 'id, restaurant_id, name, active, created_at';

router.get('/', validateQuery(listTablesQuerySchema), async (req, res, next) => {
  try {
    const params = [req.user.restaurantId];
    let where = 'restaurant_id = $1';

    if (req.query.active !== undefined) {
      params.push(req.query.active);
      where += ` AND active = $${params.length}`;
    }

    params.push(req.query.limit, req.query.offset);
    const { rows } = await db.query(
      `SELECT ${TABLE_COLUMNS} FROM tables
        WHERE ${where}
        ORDER BY name ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows.map(dto.table), limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

router.post('/', requireRole('OWNER', 'MANAGER'), validateBody(createTableSchema), async (req, res, next) => {
  try {
    // UNIQUE (restaurant_id, name) makes this a no-op on a duplicate rather
    // than a 500 from a constraint violation.
    const { rows } = await db.query(
      `INSERT INTO tables (restaurant_id, name)
       VALUES ($1, $2)
       ON CONFLICT (restaurant_id, name) DO NOTHING
       RETURNING ${TABLE_COLUMNS}`,
      [req.user.restaurantId, req.body.name]
    );
    if (!rows.length) throw new ApiError('TABLE_NAME_TAKEN', 'A table with that name already exists');

    await logAudit({
      ...auditContext(req),
      action: 'TABLE_CREATED',
      resourceType: 'table',
      resourceId: rows[0].id,
      details: { name: rows[0].name }
    });

    res.status(201).json(dto.table(rows[0]));
  } catch (err) { next(err); }
});

/**
 * The floor: every table with whatever bill is open on it.
 *
 * A dashboard rendering N tables otherwise makes 1 + N calls -- list the
 * tables, then ask each one for its open bill -- and repeats that on every
 * poll. One LEFT JOIN answers it, and the one-open-bill invariant is what makes
 * the join safe: a table cannot match two rows here.
 */
router.get('/floor', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT t.id, t.restaurant_id, t.name, t.active, t.created_at,
              b.id   AS bill_id,      b.status AS bill_status,
              b.currency, b.total_due, b.subtotal_minor, b.vat_bps, b.vat_minor,
              b.service_charge_bps, b.service_charge_minor,
              b.total_due_ves, b.amount_paid_ves, b.fx_rate_ves_per_unit,
              b.updated_at AS bill_updated_at,
              (SELECT count(*)::int FROM bill_items i WHERE i.bill_id = b.id) AS item_count
         FROM tables t
         LEFT JOIN bills b
           ON b.table_id = t.id AND b.restaurant_id = t.restaurant_id AND b.status = 'OPEN'
        WHERE t.restaurant_id = $1 AND t.active = true
        ORDER BY t.name`,
      [req.user.restaurantId]
    );

    res.json({ data: rows.map(dto.floorTable) });
  } catch (err) { next(err); }
});

/**
 * Creates the tables a restaurant says it has.
 *
 * Idempotent: it fills in whatever is missing from `<prefix> 1` to
 * `<prefix> N` and leaves the rest alone, so running it twice is not an error
 * and raising the count later adds only the new ones. It never deletes -- a
 * table that already carries bills is not something a number in a form should
 * be able to remove.
 */
router.post(
  '/bulk',
  requireRole('OWNER', 'MANAGER'),
  validateBody(bulkTablesSchema),
  async (req, res, next) => {
    try {
      const names = Array.from({ length: req.body.count }, (_, i) => `${req.body.prefix} ${i + 1}`);

      const { rows } = await db.query(
        `INSERT INTO tables (restaurant_id, name)
         SELECT $1, name FROM unnest($2::text[]) AS name
         ON CONFLICT (restaurant_id, name) DO NOTHING
         RETURNING ${TABLE_COLUMNS}`,
        [req.user.restaurantId, names]
      );

      await logAudit({
        ...auditContext(req),
        action: 'TABLES_BULK_CREATED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { requested: req.body.count, created: rows.length, prefix: req.body.prefix }
      });

      const all = await db.query(
        `SELECT ${TABLE_COLUMNS} FROM tables
          WHERE restaurant_id = $1 AND active = true ORDER BY name`,
        [req.user.restaurantId]
      );

      res.status(201).json({
        created: rows.length,
        alreadyExisted: req.body.count - rows.length,
        data: all.rows.map(dto.table)
      });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/:tableId',
  requireRole('OWNER', 'MANAGER'),
  validateParams(tableIdParamSchema),
  validateBody(updateTableSchema),
  async (req, res, next) => {
    try {
      // COALESCE keeps this a partial update: an omitted field is left as-is
      // rather than being nulled.
      const { rows } = await db.query(
        `UPDATE tables
            SET name = COALESCE($1, name),
                active = COALESCE($2, active)
          WHERE id = $3 AND restaurant_id = $4
        RETURNING ${TABLE_COLUMNS}`,
        [req.body.name ?? null, req.body.active ?? null, req.params.tableId, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('TABLE_NOT_FOUND', 'Table not found');

      await logAudit({
        ...auditContext(req),
        action: 'TABLE_UPDATED',
        resourceType: 'table',
        resourceId: rows[0].id,
        details: { name: req.body.name, active: req.body.active }
      });

      res.json(dto.table(rows[0]));
    } catch (err) {
      // Renaming onto an existing name trips the unique index.
      if (err.code === '23505') {
        return next(new ApiError('TABLE_NAME_TAKEN', 'A table with that name already exists'));
      }
      next(err);
    }
  }
);

module.exports = router;
