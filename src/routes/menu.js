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
  restaurantIdParamSchema,
  menuOcrImportSchema
} = require('../middleware/schemas');
const { logAudit, auditContext } = require('../services/audit');
const dto = require('../dto');
const { ApiError } = require('../errors');
const config = require('../config');
const rateLimit = require('../middleware/rateLimit');
const menuOcr = require('../services/menuOcr');
const multer = require('multer');

/**
 * The menu upload.
 *
 * In memory rather than on disk: the file is read once, turned into a request
 * to the vision provider and dropped. Nothing about a menu photo is worth
 * persisting -- the extracted text is the product, the image is packaging --
 * and a file never written cannot be leaked or forgotten about.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.menuOcr.maxUploadBytes, files: 1 }
});

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
    res.json({
      ...dto.menuCharges(rows[0]),
      /**
       * Whether this deployment can read a menu from a photo at all.
       *
       * The reader is opt-in per deployment -- it costs money per call and
       * reaches a third party -- so a server without a key answers 503. Until
       * this field existed the client had no way to know that in advance: it
       * offered the upload, the user chose a photo, waited for several
       * megabytes to go up, and only then learned the feature was never
       * available here. Asking is free, and the answer does not change between
       * requests.
       *
       * Added here and not to the charges PATCH below, because it is a fact
       * about the server rather than a setting the restaurant owns. Nothing a
       * client sends can change it.
       */
      menuOcrAvailable: menuOcr.isConfigured()
    });
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

/**
 * Read a menu from a photo or PDF.
 *
 * Returns a draft and writes nothing. The vision model proposes items and this
 * hands them back for a person to check -- the same division of labour as a
 * declared Pago Móvil, and for the same reason: the machine is confident in
 * ways it has not earned. A misread price is charged to every diner who orders
 * that dish until somebody notices, so the confirmation step is the feature,
 * not friction around it.
 *
 * Rate limited hard. Each call costs money at a third party and takes seconds
 * of a model's time; a menu is uploaded once and then corrected on screen, so
 * ten in a minute is already generous.
 */
router.post(
  '/ocr-extract',
  requireRole('OWNER', 'MANAGER'),
  rateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'menu:ocr' }),
  (req, res, next) => upload.single('file')(req, res, err => {
    // Multer's own limit errors, translated so a client sees the same envelope
    // as everywhere else rather than a stray 500. Anything unrecognised is
    // passed through untouched: dressing an unknown fault as "send a file"
    // would send somebody looking in the wrong place.
    if (!err) return next();
    const known = {
      LIMIT_FILE_SIZE: () => new ApiError('MENU_OCR_FILE_TOO_LARGE', 'That file is too large', {
        maxBytes: config.menuOcr.maxUploadBytes
      }),
      LIMIT_FILE_COUNT: () => new ApiError('MENU_OCR_FILE_REQUIRED', 'Upload one menu file at a time'),
      LIMIT_UNEXPECTED_FILE: () => new ApiError('MENU_OCR_FILE_REQUIRED',
        'Upload the menu in the "file" field')
    }[err.code];
    return next(known ? known() : err);
  }),
  async (req, res, next) => {
    try {
      if (!req.file?.buffer?.length) {
        throw new ApiError('MENU_OCR_FILE_REQUIRED', 'Upload a menu image or PDF in the "file" field');
      }

      const { rows } = await db.query(
        'SELECT menu_currency FROM restaurants WHERE id = $1',
        [req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      const result = await menuOcr.extractMenu({
        buffer: req.file.buffer,
        contentType: req.file.mimetype,
        // The restaurant's own setting, never the model's guess and never the
        // request's: a menu printed in dollars does not change what this
        // restaurant charges in.
        currency: rows[0].menu_currency
      });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_OCR_EXTRACTED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { items: result.items.length, pages: result.pages, needsReview: result.needsReview }
      });

      res.json(result);
    } catch (err) { next(err); }
  }
);

/**
 * Commit the reviewed items to the menu.
 *
 * This is the write, and it takes what the staff member confirmed -- not what
 * the model said. A client could post this body having uploaded nothing at all
 * and it would be equally valid, which is the point: the extraction has no
 * authority here, and the validation is the same a hand-typed product gets.
 *
 * Each row is inserted inside its own SAVEPOINT so that one duplicate name does
 * not discard the other forty-nine. Without it the first 23505 aborts the whole
 * transaction and every later insert fails with 25P02 -- the reason a plain
 * try/catch around the insert cannot do what it appears to.
 */
router.post(
  '/ocr-import',
  requireRole('OWNER', 'MANAGER'),
  validateBody(menuOcrImportSchema),
  async (req, res, next) => {
    try {
      const restaurantId = req.user.restaurantId;
      const { rows } = await db.query(
        'SELECT menu_currency FROM restaurants WHERE id = $1',
        [restaurantId]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
      const currency = rows[0].menu_currency;

      const { imported, errors } = await db.withTransaction(async client => {
        const inserted = [];
        const failures = [];

        for (const [index, item] of req.body.items.entries()) {
          await client.query('SAVEPOINT item');
          try {
            const result = await client.query(
              `INSERT INTO menu_products
                 (restaurant_id, name, description, price_minor_units, currency, active)
               VALUES ($1, $2, $3, $4, $5, true)
               RETURNING ${PRODUCT_COLUMNS}`,
              [restaurantId, item.name, item.description || null, item.priceMinorUnits, currency]
            );
            await client.query('RELEASE SAVEPOINT item');
            inserted.push(result.rows[0]);
          } catch (err) {
            await client.query('ROLLBACK TO SAVEPOINT item');
            if (err.code === '23505') {
              // Reported per row rather than failing the import: the reviewer
              // renames that one and imports it, keeping the rest.
              failures.push({
                index, name: item.name, code: 'PRODUCT_NAME_TAKEN',
                message: 'A product with that name already exists on this menu'
              });
            } else {
              throw err;
            }
          }
        }

        return { imported: inserted, errors: failures };
      });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_OCR_IMPORTED',
        resourceType: 'restaurant',
        resourceId: restaurantId,
        details: { imported: imported.length, rejected: errors.length }
      });

      res.status(201).json({
        importedCount: imported.length,
        items: imported.map(dto.product),
        errors
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
