const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody,
  validateParams,
  validateQuery,
  menuCurrencySchema,
  menuChargesSchema,
  deleteProductQuerySchema,
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  restaurantIdParamSchema
} = require('../middleware/schemas');
const { logAudit, auditContext } = require('../services/audit');
const dto = require('../dto');
const { ApiError } = require('../errors');

const router = express.Router();

const PRODUCT_COLUMNS = `id, name, description, price_minor_units,
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
        'SELECT id, name, menu_currency FROM restaurants WHERE id = $1 AND active = true',
        [req.params.restaurantId]
      );
      if (!restaurant.rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      const { rows } = await db.query(
        `SELECT id, name, description, price_minor_units, currency
           FROM menu_products
          WHERE restaurant_id = $1 AND active = true
          ORDER BY name`,
        [req.params.restaurantId]
      );

      res.json({ restaurant: dto.menuSettings(restaurant.rows[0]), products: rows.map(dto.publicProduct) });
    } catch (err) { next(err); }
  }
);

// Everything below is staff-only.
router.use(authenticateToken);

router.get('/settings', async (req, res, next) => {
  try {
    // Carries the charge rates too: a settings screen needs to show what IVA
    // and servicio are currently set to before it can offer to change them.
    const { rows } = await db.query(
      'SELECT id, name, menu_currency, vat_bps, service_charge_bps FROM restaurants WHERE id = $1',
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
    res.json(dto.menuCharges(rows[0]));
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
        throw new ApiError(
          'MENU_CURRENCY_MISMATCH',
          'Active menu contains products priced in another currency. Update or deactivate them first.',
          { activeProductsInOtherCurrency: mismatch.rows[0].n }
        );
      }

      const { rows } = await db.query(
        'UPDATE restaurants SET menu_currency = $1 WHERE id = $2 RETURNING id, name, menu_currency',
        [req.body.currency, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CURRENCY_CHANGED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { currency: req.body.currency }
      });

      res.json(dto.menuSettings(rows[0]));
    } catch (err) { next(err); }
  }
);

/**
 * IVA and servicio rates.
 *
 * Both are snapshotted onto a bill when it opens, so changing them here never
 * reprices a meal already being eaten -- and equally, a bill that is already
 * open keeps the rates it started with. Close or void an open bill if it needs
 * the new figures.
 */
router.patch(
  '/settings/charges',
  requireRole('OWNER', 'MANAGER'),
  validateBody(menuChargesSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `UPDATE restaurants
            SET vat_bps = COALESCE($1, vat_bps),
                service_charge_bps = COALESCE($2, service_charge_bps)
          WHERE id = $3
        RETURNING id, name, menu_currency, vat_bps, service_charge_bps`,
        [req.body.vatBps ?? null, req.body.serviceChargeBps ?? null, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      await logAudit({
        ...auditContext(req),
        action: 'MENU_CHARGES_CHANGED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { vatBps: req.body.vatBps, serviceChargeBps: req.body.serviceChargeBps }
      });

      const open = await db.query(
        "SELECT count(*)::int AS n FROM bills WHERE restaurant_id = $1 AND status = 'OPEN'",
        [req.user.restaurantId]
      );

      res.json({
        ...dto.menuCharges(rows[0]),
        // Said out loud rather than left to be discovered: these bills keep the
        // rates they opened with.
        openBillsUnaffected: open.rows[0].n
      });
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

    res.json({ data: rows.map(dto.product), limit: req.query.limit, offset: req.query.offset });
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
      if (!restaurant.rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

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

      res.status(201).json(dto.product(rows[0]));
    } catch (err) {
      if (err.code === '23505') {
        return next(new ApiError('PRODUCT_NAME_TAKEN', 'A product with that name already exists'));
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
      if (!rows.length) throw new ApiError('PRODUCT_NOT_FOUND', 'Product not found');

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCT_UPDATED',
        resourceType: 'menu_product',
        resourceId: rows[0].id
      });

      res.json(dto.product(rows[0]));
    } catch (err) {
      if (err.code === '23505') {
        return next(new ApiError('PRODUCT_NAME_TAKEN', 'A product with that name already exists'));
      }
      next(err);
    }
  }
);

/**
 * Removes a product.
 *
 * Deactivates by default, which is the safe thing to do to something a bill
 * might reference. `?permanent=true` deletes the row outright, which is safe
 * because `bill_items.product_id` is ON DELETE SET NULL and every line carries
 * its own name and price snapshot -- an old bill stays exactly as it was
 * served, it just loses the reporting link.
 *
 * Permanent removal exists because deactivated products accumulate: after a
 * menu-currency change the old ones linger in the list forever with no way to
 * clear them.
 */
router.delete(
  '/products/:id',
  requireRole('OWNER', 'MANAGER'),
  validateParams(productIdParamSchema),
  validateQuery(deleteProductQuerySchema),
  async (req, res, next) => {
    try {
      const { rows } = req.query.permanent
        ? await db.query(
          'DELETE FROM menu_products WHERE id = $1 AND restaurant_id = $2 RETURNING id',
          [req.params.id, req.user.restaurantId]
        )
        : await db.query(
          'UPDATE menu_products SET active = false WHERE id = $1 AND restaurant_id = $2 RETURNING id',
          [req.params.id, req.user.restaurantId]
        );
      if (!rows.length) throw new ApiError('PRODUCT_NOT_FOUND', 'Product not found');

      await logAudit({
        ...auditContext(req),
        action: req.query.permanent ? 'MENU_PRODUCT_DELETED' : 'MENU_PRODUCT_DEACTIVATED',
        resourceType: 'menu_product',
        resourceId: rows[0].id
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
