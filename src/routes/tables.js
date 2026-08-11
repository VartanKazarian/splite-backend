const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody,
  validateParams,
  validateQuery,
  createTableSchema,
  updateTableSchema,
  listTablesQuerySchema,
  tableIdParamSchema
} = require('../middleware/schemas');
const { logAudit, auditContext } = require('../services/audit');
const dto = require('../dto');

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
    if (!rows.length) return res.status(409).json({ error: 'A table with that name already exists' });

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
      if (!rows.length) return res.status(404).json({ error: 'Table not found' });

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
      if (err.code === '23505') return res.status(409).json({ error: 'A table with that name already exists' });
      next(err);
    }
  }
);

module.exports = router;
