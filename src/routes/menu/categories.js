/** Menu sections: list, create, rename, reorder, delete. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const {
  validateBody,
  validateParams,
  createCategorySchema,
  updateCategorySchema,
  reorderCategoriesSchema,
  categoryIdParamSchema
} = require('../../middleware/schemas');
const { logAudit, auditContext } = require('../../services/audit');
const dto = require('../../dto');
const { ApiError } = require('../../errors');

const router = express.Router();

/**
 * The sections, with how much is in each.
 *
 * Its own endpoint rather than a shape nested inside `/products`, because the
 * two are paginated differently: a client renders every section header at once
 * and pages through the food underneath. Deriving the headers from a page of
 * products would hide any section whose items fell past the limit.
 */
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.position, c.active,
              count(p.id) AS product_count
         FROM menu_categories c
         LEFT JOIN menu_products p
           ON p.category_id = c.id AND p.restaurant_id = c.restaurant_id
        WHERE c.restaurant_id = $1
        GROUP BY c.id
        ORDER BY c.position, c.name`,
      [req.user.restaurantId]
    );

    // The uncategorised bucket is counted too. It has no row in
    // menu_categories and so cannot appear above, but a screen that groups by
    // section still has to show it -- and a product filed nowhere is precisely
    // the one somebody needs to notice.
    const loose = await db.query(
      `SELECT count(*) AS product_count FROM menu_products
        WHERE restaurant_id = $1 AND category_id IS NULL`,
      [req.user.restaurantId]
    );

    res.json({
      data: rows.map(dto.menuCategory),
      uncategorisedCount: Number(loose.rows[0].product_count)
    });
  } catch (err) { next(err); }
});

/**
 * Sections a restaurant maintains by hand.
 *
 * Until now the only way to get one was an OCR import inventing them from the
 * headings it read off a photograph, which is fine for the first menu and no
 * use at all afterwards: a restaurant that adds a dessert list, renames
 * "Bebidas" to "Para beber", or wants the drinks to stop appearing first had
 * nowhere to say so.
 *
 * Every route below is tenant-scoped in its WHERE clause rather than trusting
 * the id it was handed. The composite foreign key on menu_products makes a
 * cross-tenant *assignment* impossible, but nothing stops a caller naming
 * another restaurant's category id here, and a rename is a write.
 */
router.post(
  '/categories',
  requireRole('OWNER', 'MANAGER'),
  validateBody(createCategorySchema),
  async (req, res, next) => {
    try {
      // Omitted position means the end of the menu. Computed here rather than
      // defaulted to 0 in the schema, which would silently file every new
      // section first and make the order depend on the name tie-break.
      let position = req.body.position;
      if (position === undefined) {
        const { rows } = await db.query(
          'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM menu_categories WHERE restaurant_id = $1',
          [req.user.restaurantId]
        );
        position = Number(rows[0].next);
      }

      let created;
      try {
        const { rows } = await db.query(
          `INSERT INTO menu_categories (restaurant_id, name, position, active)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, position, active`,
          [req.user.restaurantId, req.body.name, position, req.body.active]
        );
        created = rows[0];
      } catch (err) {
        // UNIQUE (restaurant_id, name). Caught rather than pre-checked: a
        // SELECT then INSERT is a race, and two managers adding "Postres" at
        // once would both pass the check.
        if (err.code === '23505') {
          throw new ApiError('CATEGORY_NAME_TAKEN', 'A section with that name already exists', {
            name: req.body.name
          });
        }
        throw err;
      }

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CATEGORY_CREATED',
        resourceType: 'menu_category',
        resourceId: created.id
      });

      res.status(201).json(dto.menuCategory(created));
    } catch (err) { next(err); }
  }
);

router.patch(
  '/categories/:id',
  requireRole('OWNER', 'MANAGER'),
  validateParams(categoryIdParamSchema),
  validateBody(updateCategorySchema),
  async (req, res, next) => {
    try {
      let updated;
      try {
        const { rows } = await db.query(
          `UPDATE menu_categories
              SET name = COALESCE($3, name),
                  position = COALESCE($4, position),
                  active = COALESCE($5, active)
            WHERE id = $1 AND restaurant_id = $2
            RETURNING id, name, position, active`,
          [
            req.params.id, req.user.restaurantId,
            req.body.name ?? null,
            req.body.position ?? null,
            // COALESCE works for `active` because the schema has no null: the
            // field is either a boolean or absent.
            req.body.active === undefined ? null : req.body.active
          ]
        );
        updated = rows[0];
      } catch (err) {
        if (err.code === '23505') {
          throw new ApiError('CATEGORY_NAME_TAKEN', 'A section with that name already exists', {
            name: req.body.name
          });
        }
        throw err;
      }
      if (!updated) throw new ApiError('CATEGORY_NOT_FOUND', 'Section not found');

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CATEGORY_UPDATED',
        resourceType: 'menu_category',
        resourceId: updated.id
      });

      res.json(dto.menuCategory(updated));
    } catch (err) { next(err); }
  }
);

/**
 * The whole order at once.
 *
 * A drag-and-drop sends the list it ended up with, and it is applied in one
 * statement: position becomes the index in the array. Doing it as N separate
 * PATCHes would make every half-applied ordering a state a concurrent reader
 * could see, and a dropped request would leave the menu in it permanently.
 *
 * Ids belonging to another restaurant simply do not match the WHERE clause, so
 * a list padded with somebody else's sections reorders nothing of theirs. The
 * count is compared afterwards so the caller is told rather than left guessing.
 */
router.put(
  '/categories/order',
  requireRole('OWNER', 'MANAGER'),
  validateBody(reorderCategoriesSchema),
  async (req, res, next) => {
    try {
      // In a transaction, because the check is part of the write. The UPDATE
      // matches only this tenant's rows, so a list padded with somebody else's
      // ids reorders the rest and *then* fails -- leaving the menu half
      // reordered by a request that was answered 404. Rolling back makes the
      // refusal mean what it says.
      await db.withTransaction(async client => {
        const { rows } = await client.query(
          `UPDATE menu_categories AS c
              SET position = o.ordinality - 1
             FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ordinality)
            WHERE c.id = o.id AND c.restaurant_id = $1
            RETURNING c.id`,
          [req.user.restaurantId, req.body.ids]
        );

        if (rows.length !== req.body.ids.length) {
          throw new ApiError('CATEGORY_NOT_FOUND', 'One or more sections do not exist');
        }
      });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CATEGORIES_REORDERED',
        resourceType: 'menu_category',
        resourceId: null
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

/**
 * Deleting a section does not delete its food.
 *
 * The foreign key is ON DELETE SET NULL (category_id), so the products fall
 * back into the uncategorised bucket, still active and still sellable. That is
 * the behaviour a restaurant expects from removing a heading, and the
 * alternative -- taking the dishes with it -- would be a way to lose a menu by
 * tidying it.
 */
router.delete(
  '/categories/:id',
  requireRole('OWNER', 'MANAGER'),
  validateParams(categoryIdParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2 RETURNING id',
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('CATEGORY_NOT_FOUND', 'Section not found');

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CATEGORY_DELETED',
        resourceType: 'menu_category',
        resourceId: req.params.id
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
