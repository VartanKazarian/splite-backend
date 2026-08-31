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
                         currency, category_id, position, active,
                         created_at, updated_at`;

/**
 * The order a menu is read in.
 *
 * Section first, then the item's place inside it, then name. Name is the
 * tie-break rather than the sort: everything imported at once shares position
 * 0, and alphabetical-within-a-section is a reasonable default until somebody
 * reorders it. NULLS LAST puts uncategorised products after every named
 * section, which is where a reviewer expects to find the ones still to be
 * filed rather than scattered through the list.
 */
const MENU_ORDER = `c.position NULLS LAST, c.name NULLS LAST, p.position, p.name`;

/**
 * A write that answers with the same product shape a read does.
 *
 * RETURNING cannot join, so a bare INSERT would hand back category_id and no
 * category_name -- and `dto.product` would report the section as null on the
 * very request that set it. One statement rather than a second round trip.
 */
const withCategoryName = inner => `
  WITH written AS (${inner})
  SELECT w.id, w.name, w.description, w.price_minor_units, w.currency,
         w.category_id, w.position, w.active, w.created_at, w.updated_at,
         c.name AS category_name
    FROM written w
    LEFT JOIN menu_categories c
      ON c.id = w.category_id AND c.restaurant_id = w.restaurant_id`;

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

      // A section that has been switched off hides its food from diners without
      // deactivating each product: the kitchen ran out of fish, and the whole
      // pescados block goes off the menu for the evening.
      const { rows } = await db.query(
        `SELECT p.id, p.name, p.description, p.price_minor_units, p.currency,
                p.category_id, c.name AS category_name
           FROM menu_products p
           LEFT JOIN menu_categories c
             ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id AND c.active = true
          WHERE p.restaurant_id = $1
            AND p.active = true
            AND (p.category_id IS NULL OR c.id IS NOT NULL)
          ORDER BY ${MENU_ORDER}`,
        [req.params.restaurantId]
      );

      const categories = await db.query(
        `SELECT id, name, position, active FROM menu_categories
          WHERE restaurant_id = $1 AND active = true
          ORDER BY position, name`,
        [req.params.restaurantId]
      );

      res.json({
        restaurant: dto.menuSettings(restaurant.rows[0]),
        // Sent alongside rather than nested, so a client can render the section
        // headers in order -- including an empty one -- without inferring the
        // order from whichever products happened to come back.
        categories: categories.rows.map(dto.menuCategory),
        products: rows.map(dto.publicProduct)
      });
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

router.get('/products', validateQuery(listProductsQuerySchema), async (req, res, next) => {
  try {
    const params = [req.user.restaurantId];
    let where = 'p.restaurant_id = $1';
    if (req.query.active !== undefined) {
      params.push(req.query.active);
      where += ` AND p.active = $${params.length}`;
    }
    if (req.query.categoryId === 'none') {
      where += ' AND p.category_id IS NULL';
    } else if (req.query.categoryId !== undefined) {
      params.push(req.query.categoryId);
      where += ` AND p.category_id = $${params.length}`;
    }

    params.push(req.query.limit, req.query.offset);
    const { rows } = await db.query(
      `SELECT p.id, p.name, p.description, p.price_minor_units, p.currency,
              p.category_id, p.position, p.active, p.created_at, p.updated_at,
              c.name AS category_name
         FROM menu_products p
         LEFT JOIN menu_categories c
           ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id
        WHERE ${where}
        ORDER BY ${MENU_ORDER}
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
        withCategoryName(`
          INSERT INTO menu_products
            (restaurant_id, name, description, price_minor_units, currency, category_id, active)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *`),
        [
          req.user.restaurantId,
          req.body.name,
          req.body.description || null,
          req.body.priceMinorUnits,
          restaurant.rows[0].menu_currency,
          req.body.categoryId ?? null,
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
      // categoryId cannot ride on COALESCE like the rest: null is a value here,
      // meaning "out of every section", and COALESCE cannot tell that from an
      // omitted field. A separate flag says whether the caller mentioned it.
      const setsCategory = Object.prototype.hasOwnProperty.call(req.body, 'categoryId');
      const { rows } = await db.query(
        withCategoryName(`
          UPDATE menu_products
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 price_minor_units = COALESCE($3, price_minor_units),
                 active = COALESCE($4, active),
                 category_id = CASE WHEN $5::boolean THEN $6::uuid ELSE category_id END
           WHERE id = $7 AND restaurant_id = $8
          RETURNING *`),
        [
          req.body.name ?? null,
          req.body.description === undefined ? null : (req.body.description || null),
          req.body.priceMinorUnits ?? null,
          req.body.active ?? null,
          setsCategory,
          req.body.categoryId ?? null,
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

      const { imported, errors, createdCategories } = await db.withTransaction(async client => {
        const inserted = [];
        const failures = [];

        /**
         * The sections, resolved in the order they were printed.
         *
         * Position comes from where a section first appears in the payload,
         * not from its name: the reader walks the page top to bottom, so
         * first-seen is the menu's own sequence -- Entradas before Postres,
         * which alphabetical ordering would reverse.
         *
         * Existing sections keep the position they already have. A second
         * import must not renumber a menu somebody has since reordered by
         * hand, and ON CONFLICT DO NOTHING says so; the SELECT afterwards is
         * what returns the row either way.
         */
        const categoryIds = new Map();
        const before = await client.query(
          'SELECT COALESCE(MAX(position), -1) AS max FROM menu_categories WHERE restaurant_id = $1',
          [restaurantId]
        );
        let nextPosition = Number(before.rows[0].max) + 1;
        const madeCategories = [];

        for (const item of req.body.items) {
          const section = (item.section || '').trim();
          if (!section || categoryIds.has(section)) continue;

          const found = await client.query(
            'SELECT id FROM menu_categories WHERE restaurant_id = $1 AND name = $2',
            [restaurantId, section]
          );
          if (found.rows.length) {
            categoryIds.set(section, found.rows[0].id);
            continue;
          }

          const made = await client.query(
            `INSERT INTO menu_categories (restaurant_id, name, position)
             VALUES ($1, $2, $3) RETURNING id, name, position, active`,
            [restaurantId, section, nextPosition++]
          );
          categoryIds.set(section, made.rows[0].id);
          madeCategories.push(made.rows[0]);
        }

        for (const [index, item] of req.body.items.entries()) {
          await client.query('SAVEPOINT item');
          try {
            const result = await client.query(
              `INSERT INTO menu_products
                 (restaurant_id, name, description, price_minor_units, currency, category_id, position, active)
               VALUES ($1, $2, $3, $4, $5, $6, $7, true)
               RETURNING ${PRODUCT_COLUMNS}`,
              [
                restaurantId, item.name, item.description || null, item.priceMinorUnits, currency,
                categoryIds.get((item.section || '').trim()) ?? null,
                // Its place on the page, so the menu reads in the order it was
                // printed rather than alphabetically inside each section.
                index
              ]
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

        return { imported: inserted, errors: failures, createdCategories: madeCategories };
      });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_OCR_IMPORTED',
        resourceType: 'restaurant',
        resourceId: restaurantId,
        details: {
          imported: imported.length,
          rejected: errors.length,
          categoriesCreated: createdCategories.length
        }
      });

      res.status(201).json({
        importedCount: imported.length,
        // What the import decided about structure, reported rather than left
        // to be discovered: a reviewer who sees six new sections named after
        // their own menu knows it worked, and one who sees none knows the
        // photo had no headings the reader could find.
        categoriesCreated: createdCategories.map(dto.menuCategory),
        items: imported.map(dto.product),
        errors
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
