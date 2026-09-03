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

/**
 * Creates a table, or brings back the deactivated one that holds the name.
 *
 * Deleting a table in the panel is `PATCH { active: false }` -- there is no
 * DELETE, because a table carries bills and history that must not vanish. The
 * row therefore survives, still holding its name under
 * `UNIQUE (restaurant_id, name)`, while disappearing from every screen that
 * filters on `active`. Creating that name again used to be refused as taken,
 * by a table nobody could see: a dead end with no way out of it from the panel.
 *
 * So a conflict with an *inactive* row reactivates it instead of refusing. The
 * name is the restaurant's word for a physical table, and asking for it back is
 * asking for that table back. Reviving the same row -- rather than minting a
 * new one -- is also what keeps the printed QR sticker working: guest lookups
 * require `active = true` (src/routes/guest.js), so the code on the table went
 * dead when it was deactivated and comes back with it. A new row would have a
 * new id and a new nonce, and the sticker on that table would stay dead.
 *
 * A conflict with an *active* row is still refused. That is a name genuinely in
 * use, and the panel can see it.
 *
 * One statement, so two staff creating the same name at once cannot both
 * succeed: the unique index decides, and the loser takes the ON CONFLICT path.
 * `xmax = 0` is true only for a tuple this statement inserted, which is how an
 * upsert tells "created" from "revived" without a second read.
 */
router.post('/', requireRole('OWNER', 'MANAGER'), validateBody(createTableSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `INSERT INTO tables (restaurant_id, name)
       VALUES ($1, $2)
       ON CONFLICT (restaurant_id, name) DO UPDATE
         SET active = true
         WHERE tables.active = false
       RETURNING ${TABLE_COLUMNS}, (xmax = 0) AS created`,
      [req.user.restaurantId, req.body.name]
    );
    if (!rows.length) {
      throw new ApiError('TABLE_NAME_TAKEN', 'A table with that name already exists');
    }

    const created = rows[0].created;
    await logAudit({
      ...auditContext(req),
      // Distinct actions: a table coming back is not the same event as a table
      // being opened for the first time, and the audit log is where the
      // difference is legible -- the row carries its original created_at.
      action: created ? 'TABLE_CREATED' : 'TABLE_REACTIVATED',
      resourceType: 'table',
      resourceId: rows[0].id,
      details: { name: rows[0].name }
    });

    // 201 for a new table, 200 for one that already existed and was reactivated:
    // nothing was created in that case, and the id in the body is not new.
    res.status(created ? 201 : 200).json(dto.table(rows[0]));
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
              b.created_at AS bill_opened_at,
              (SELECT count(*)::int FROM bill_items i WHERE i.bill_id = b.id) AS item_count,
              -- Somebody at this table says they have paid and nobody has
              -- checked yet. It is the one per-table fact a floor view cannot
              -- derive from the bill, and the one that has a diner waiting.
              (SELECT count(*)::int FROM payments pc
                WHERE pc.bill_id = b.id AND pc.restaurant_id = b.restaurant_id
                  AND pc.status = 'PENDING' AND pc.payment_method = 'PAGO_MOVIL') AS pending_claims,
              -- Tips already settled on this bill, so a table that tipped well
              -- is visible while the diners are still sitting at it.
              (SELECT COALESCE(SUM(pt.tip_ves), 0)::BIGINT FROM payments pt
                WHERE pt.bill_id = b.id AND pt.restaurant_id = b.restaurant_id
                  AND pt.status = 'SUCCEEDED') AS tip_ves
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
 *
 * A deactivated table in the range comes back, for the same reason POST does
 * it: asking for ten tables and being handed nine, with no way to say which
 * one is missing or why, is the deletion surprising the restaurant a second
 * time. Only the tables named by the range are touched -- one deactivated
 * outside it stays deactivated.
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
         ON CONFLICT (restaurant_id, name) DO UPDATE
           SET active = true
           WHERE tables.active = false
         RETURNING ${TABLE_COLUMNS}, (xmax = 0) AS created`,
        [req.user.restaurantId, names]
      );

      const created = rows.filter(row => row.created).length;
      const reactivated = rows.length - created;

      await logAudit({
        ...auditContext(req),
        action: 'TABLES_BULK_CREATED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { requested: req.body.count, created, reactivated, prefix: req.body.prefix }
      });

      const all = await db.query(
        `SELECT ${TABLE_COLUMNS} FROM tables
          WHERE restaurant_id = $1 AND active = true ORDER BY name`,
        [req.user.restaurantId]
      );

      res.status(201).json({
        created,
        reactivated,
        // What was already there and already active, so this call left it
        // alone. Reactivated tables are counted on their own rather than
        // folded in here: something did change for them.
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
      // Renaming onto an existing name trips the unique index. Unlike POST,
      // this one cannot resolve itself by reviving the other row -- that would
      // leave two tables wanting one name -- so it stays a refusal. What it
      // does say is *which* table is in the way, because the blocker may be
      // deactivated and therefore invisible on every screen the person
      // renaming is looking at. Same tenant, so this discloses nothing they
      // could not already list.
      if (err.code === '23505') {
        const holder = (await db.query(
          'SELECT id, active FROM tables WHERE restaurant_id = $1 AND name = $2',
          [req.user.restaurantId, req.body.name]
        )).rows[0];
        return next(new ApiError(
          'TABLE_NAME_TAKEN',
          holder && !holder.active
            ? 'A deactivated table already has that name; reactivate it instead of renaming onto it'
            : 'A table with that name already exists',
          holder ? { tableId: holder.id, active: holder.active } : undefined
        ));
      }
      next(err);
    }
  }
);

module.exports = router;
