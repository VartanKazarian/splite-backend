const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody,
  validateParams,
  validateQuery,
  menuCurrencySchema,
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  restaurantIdParamSchema
} = require('../middleware/schemas');
const { logAudit, auditContext } = require('../services/audit');

const router = express.Router();

const PRODUCT_COLUMNS = `id, name, description,
                         price_minor_units AS "priceMinorUnits",
                         currency, active, created_at, updated_at`;

/**
 * Public menu for a restaurant.
 *
 * Declared before the authenticated routes below because this is the one
 * endpoint here that must not require a token: a guest scanning a table QR has
 * no staff credentials.
 */
router.get(
  '/public/:restaurantId/products',
  validateParams(restaurantIdParamSchema),
  async (req, res, next) => {
    try {
      const restaurant = await db.query(
        'SELECT id, name, menu_currency AS "menuCurrency" FROM restaurants WHERE id = $1 AND active = true',
        [req.params.restaurantId]
      );
      if (!restaurant.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

      const { rows } = await db.query(
        `SELECT id, name, description, price_minor_units AS "priceMinorUnits", currency
           FROM menu_products
          WHERE restaurant_id = $1 AND active = true
          ORDER BY name`,
        [req.params.restaurantId]
      );

      res.json({ restaurant: restaurant.rows[0], products: rows });
    } catch (err) { next(err); }
  }
);

// Everything below is staff-only.
router.use(authenticateToken);

router.get('/settings', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, name, menu_currency AS "menuCurrency" FROM restaurants WHERE id = $1',
      [req.user.restaurantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/**
 * Changing the menu currency does not reprice anything.
 *
 * Existing products keep the currency they were created in, so the change is
 * refused while any active product still disagrees. Silently converting prices
 * would be guessing at a rate on the restaurant's behalf; silently leaving them
 * would mean a menu quoting two currencies at once.
 */
router.patch(
  '/settings/currency',
  requireRole('OWNER', 'MANAGER'),
  validateBody(menuCurrencySchema),
  async (req, res, next) => {
    try {
      const mismatch = await db.query(
        'SELECT count(*)::int AS n FROM menu_products WHERE restaurant_id = $1 AND active = true AND currency <> $2',
        [req.user.restaurantId, req.body.currency]
      );
      if (mismatch.rows[0].n > 0) {
        return res.status(409).json({
          error: 'Active menu contains products priced in another currency. Update or deactivate them first.',
          code: 'MENU_CURRENCY_MISMATCH',
          activeProductsInOtherCurrency: mismatch.rows[0].n
        });
      }

      const { rows } = await db.query(
        'UPDATE restaurants SET menu_currency = $1 WHERE id = $2 RETURNING id, menu_currency AS "menuCurrency"',
        [req.body.currency, req.user.restaurantId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Restaurant not found' });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CURRENCY_CHANGED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { currency: req.body.currency }
      });

      res.json(rows[0]);
    } catch (err) { next(err); }
  }
);

router.get('/products', validateQuery(listProductsQuerySchema), async (req, res, next) => {
  try {
    const params = [req.user.restaurantId];
    let where = 'restaurant_id = $1';
    if (req.query.active !== undefined) {
      params.push(req.query.active);
      where += ` AND active = $${params.length}`;
    }

    params.push(req.query.limit, req.query.offset);
    const { rows } = await db.query(
      `SELECT ${PRODUCT_COLUMNS} FROM menu_products
        WHERE ${where}
        ORDER BY name
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({ data: rows, limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

router.post(
  '/products',
  requireRole('OWNER', 'MANAGER'),
  validateBody(createProductSchema),
  async (req, res, next) => {
    try {
      // The currency is taken from the restaurant rather than the request, so a
      // product cannot be created in a currency the menu does not use.
      const restaurant = await db.query(
        'SELECT menu_currency FROM restaurants WHERE id = $1',
        [req.user.restaurantId]
      );
      if (!restaurant.rows.length) return res.status(404).json({ error: 'Restaurant not found' });

      const { rows } = await db.query(
        `INSERT INTO menu_products (restaurant_id, name, description, price_minor_units, currency, active)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING ${PRODUCT_COLUMNS}`,
        [
          req.user.restaurantId,
          req.body.name,
          req.body.description || null,
          req.body.priceMinorUnits,
          restaurant.rows[0].menu_currency,
          req.body.active
        ]
      );

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCT_CREATED',
        resourceType: 'menu_product',
        resourceId: rows[0].id,
        details: { name: rows[0].name, currency: rows[0].currency }
      });

      res.status(201).json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A product with that name already exists' });
      }
      next(err);
    }
  }
);

router.patch(
  '/products/:id',
  requireRole('OWNER', 'MANAGER'),
  validateParams(productIdParamSchema),
  validateBody(updateProductSchema),
  async (req, res, next) => {
    try {
      // COALESCE keeps this a partial update; the currency is deliberately not
      // updatable, since it is owned by the restaurant's menu currency.
      const { rows } = await db.query(
        `UPDATE menu_products
            SET name = COALESCE($1, name),
                description = COALESCE($2, description),
                price_minor_units = COALESCE($3, price_minor_units),
                active = COALESCE($4, active)
          WHERE id = $5 AND restaurant_id = $6
        RETURNING ${PRODUCT_COLUMNS}`,
        [
          req.body.name ?? null,
          req.body.description === undefined ? null : (req.body.description || null),
          req.body.priceMinorUnits ?? null,
          req.body.active ?? null,
          req.params.id,
          req.user.restaurantId
        ]
      );
      if (!rows.length) return res.status(404).json({ error: 'Product not found' });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCT_UPDATED',
        resourceType: 'menu_product',
        resourceId: rows[0].id
      });

      res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'A product with that name already exists' });
      }
      next(err);
    }
  }
);

/** Soft delete: a product referenced by an existing bill must remain readable. */
router.delete(
  '/products/:id',
  requireRole('OWNER', 'MANAGER'),
  validateParams(productIdParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'UPDATE menu_products SET active = false WHERE id = $1 AND restaurant_id = $2 RETURNING id',
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) return res.status(404).json({ error: 'Product not found' });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCT_DEACTIVATED',
        resourceType: 'menu_product',
        resourceId: rows[0].id
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
