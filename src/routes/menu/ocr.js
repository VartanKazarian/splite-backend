/** Reading a printed menu from a photo, and importing what was read. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const { validateBody, menuOcrImportSchema } = require('../../middleware/schemas');
const { logAudit, auditContext } = require('../../services/audit');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const config = require('../../config');
const rateLimit = require('../../middleware/rateLimit');
const menuOcr = require('../../services/menuOcr');
const multer = require('multer');
const { MULTIPART_LIMITS } = require('./shared');

const router = express.Router();

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
  limits: { ...MULTIPART_LIMITS, fileSize: config.menuOcr.maxUploadBytes }
});

const PRODUCT_COLUMNS = `id, name, description, price_minor_units,
                         currency, category_id, position, active,
                         tax_category, vat_bps,
                         created_at, updated_at`;

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
