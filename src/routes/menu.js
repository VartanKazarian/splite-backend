const crypto = require('node:crypto');
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
  productImageParamSchema,
  menuOcrImportSchema,
  createCategorySchema,
  updateCategorySchema,
  reorderCategoriesSchema,
  categoryIdParamSchema
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

/**
 * The uploaded menu, which is a different kind of file from the OCR one.
 *
 * Its own limit because the two are bounded by different things: what a vision
 * model should be asked to read, against what a diner on mobile data should be
 * asked to download.
 */
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.menuPdf.maxUploadBytes, files: 1 }
});

/**
 * A dish photo. Its own limit again, and the smallest of the three: this file
 * is fetched by every diner at the table rather than by one person who chose to
 * open it.
 */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.productImage.maxUploadBytes, files: 1 }
});

/**
 * What a photo may be, and how to recognise one.
 *
 * The declared type is a claim by the client, so the bytes are checked as well:
 * each of these formats begins with a signature that a mislabelled file will
 * not have. This is not a security boundary -- the file is served back with its
 * own Content-Type, `nosniff`, and is never executed -- but it catches a HEIC
 * straight off an iPhone, or a PDF dropped in the wrong box, and says so
 * plainly instead of storing something no browser will render.
 */
const IMAGE_MEDIA = {
  'image/jpeg': buffer => buffer.subarray(0, 3).toString('hex') === 'ffd8ff',
  'image/png': buffer => buffer.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  'image/webp': buffer =>
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
};

/**
 * Multer's own rejections, translated.
 *
 * Left alone they surface as a 500 on a request whose only fault is an
 * oversized file, and the caller is told nothing it can act on.
 */
function handleUpload(handler, tooLargeCode, maxBytes) {
  return (req, res, next) => handler(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError(tooLargeCode, 'File is too large', { maxBytes }));
    }
    if (err) return next(err);
    return next();
  });
}

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
 * Whether a product has a photo, and which one, without touching the bytes.
 *
 * Selected as two scalars off a LEFT JOIN rather than by fetching the file: a
 * menu listing is the query a diner's phone makes, and it must not carry a
 * megabyte per dish. `dto.product` turns the pair into a URL -- the checksum
 * rides on the query string so that replacing a photo changes the address and a
 * cached phone stops showing the old dish.
 */
const IMAGE_COLUMNS = `(pi.product_id IS NOT NULL) AS has_image, pi.checksum AS image_checksum`;
const IMAGE_JOIN = `LEFT JOIN menu_product_images pi
             ON pi.product_id = p.id AND pi.restaurant_id = p.restaurant_id`;

/**
 * A write that answers with the same product shape a read does.
 *
 * RETURNING cannot join, so a bare INSERT would hand back category_id and no
 * category_name -- and `dto.product` would report the section as null on the
 * very request that set it. One statement rather than a second round trip.
 */
const withCategoryName = inner => `
  WITH written AS (${inner})
  SELECT w.id, w.restaurant_id, w.name, w.description, w.price_minor_units, w.currency,
         w.category_id, w.position, w.active, w.created_at, w.updated_at,
         c.name AS category_name,
         (pi.product_id IS NOT NULL) AS has_image, pi.checksum AS image_checksum
    FROM written w
    LEFT JOIN menu_categories c
      ON c.id = w.category_id AND c.restaurant_id = w.restaurant_id
    LEFT JOIN menu_product_images pi
      ON pi.product_id = w.id AND pi.restaurant_id = w.restaurant_id`;

/**
 * Public menu for a restaurant.
 *
 * Declared before the authenticated routes below because this is the one
 * endpoint here that must not require a token: a guest scanning a table QR has
 * no staff credentials.
 */
/**
 * The uploaded menu, to a diner who scanned the table QR.
 *
 * Unauthenticated, like the products route beside it and for the same reason.
 * What it serves is a file the restaurant chose to publish; there is nothing in
 * it that staff credentials would gate.
 *
 * Inline rather than as an attachment: a phone should open it, not download it.
 * The filename is still sent so a diner who does save it gets the restaurant's
 * own name for it rather than a uuid.
 */
router.get(
  '/public/:restaurantId/pdf',
  validateParams(restaurantIdParamSchema),
  rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'menu:pdfpub' }),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT d.bytes, d.content_type, d.filename, d.size_bytes, d.updated_at
           FROM menu_documents d
           JOIN restaurants r ON r.id = d.restaurant_id
          WHERE d.restaurant_id = $1 AND r.active = true`,
        [req.params.restaurantId]
      );
      const doc = rows[0];
      if (!doc) throw new ApiError('MENU_PDF_NOT_FOUND', 'No menu file uploaded');

      res.set({
        'Content-Type': doc.content_type,
        'Content-Length': String(doc.size_bytes),
        // A menu changes rarely and is fetched by every diner in the room.
        // Revalidated against the upload time so a corrected menu still lands.
        'Cache-Control': 'public, max-age=300',
        'Last-Modified': new Date(doc.updated_at).toUTCString(),
        // Stops a stored file from being interpreted as anything but what it
        // says it is, and keeps it out of a frame on another origin.
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${doc.filename.replace(/["\\]/g, '')}"`
      });
      res.send(doc.bytes);
    } catch (err) { next(err); }
  }
);

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
        `SELECT p.id, p.restaurant_id, p.name, p.description, p.price_minor_units, p.currency,
                p.category_id, c.name AS category_name, ${IMAGE_COLUMNS}
           FROM menu_products p
           LEFT JOIN menu_categories c
             ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id AND c.active = true
           ${IMAGE_JOIN}
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

      // Whether there is a file to offer, and how big it is, without reading
      // the bytes: a client decides between embedding it and linking to it, and
      // a menu that is only a PDF still has something to show when `products`
      // comes back empty.
      const document = await db.query(
        `SELECT restaurant_id, content_type, filename, size_bytes, updated_at
           FROM menu_documents WHERE restaurant_id = $1`,
        [req.params.restaurantId]
      );

      res.json({
        restaurant: dto.menuSettings(restaurant.rows[0]),
        menuPdf: document.rows[0] ? dto.menuDocument(document.rows[0]) : null,
        // Sent alongside rather than nested, so a client can render the section
        // headers in order -- including an empty one -- without inferring the
        // order from whichever products happened to come back.
        categories: categories.rows.map(dto.menuCategory),
        products: rows.map(dto.publicProduct)
      });
    } catch (err) { next(err); }
  }
);

/**
 * A dish photo, to whoever is holding the QR menu.
 *
 * Unauthenticated for the same reason as the products beside it: a diner
 * scanning a table has no staff credentials, and what this serves is a picture
 * the restaurant chose to publish.
 *
 * Scoped by restaurant *and* product, both from the path. The photo carries its
 * own `restaurant_id` (migration 033) so the check is a WHERE rather than a
 * join somebody has to remember: a product id from another tenant is a 404 here
 * whatever else is true.
 *
 * Cached hard, and safely. The URL that `dto.product` hands out carries the
 * checksum, so a given address always answers with the same bytes and may be
 * kept for a year; replacing the photo changes the checksum, which changes the
 * URL, which is what makes the new dish appear rather than the old one. The
 * ETag is still sent for a client that arrives without the suffix.
 */
router.get(
  '/public/:restaurantId/products/:productId/image',
  validateParams(productImageParamSchema),
  rateLimit({ windowSeconds: 60, max: 240, keyPrefix: 'menu:imgpub' }),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT i.bytes, i.content_type, i.size_bytes, i.checksum, i.updated_at
           FROM menu_product_images i
           JOIN menu_products p
             ON p.id = i.product_id AND p.restaurant_id = i.restaurant_id
           JOIN restaurants r ON r.id = i.restaurant_id
          WHERE i.product_id = $1 AND i.restaurant_id = $2
            AND p.active = true AND r.active = true`,
        [req.params.productId, req.params.restaurantId]
      );
      const image = rows[0];
      if (!image) throw new ApiError('PRODUCT_IMAGE_NOT_FOUND', 'This product has no photo');

      const etag = `"${image.checksum}"`;
      res.set({
        'Content-Type': image.content_type,
        ETag: etag,
        'Last-Modified': new Date(image.updated_at).toUTCString(),
        // Overrides the app-wide `same-site` from helmet, and it has to: the
        // panel and the API are different sites in every deployment we have --
        // splite.lovable.app against the Railway host -- so with `same-site`
        // the browser refuses to *render* this image even though it fetched it
        // fine. It fails as a blocked subresource, not as an HTTP error, which
        // is why nothing but a real browser catches it: the request succeeds,
        // the picture just never appears.
        //
        // Safe here in a way it would not be app-wide. This is an
        // unauthenticated picture the restaurant chose to publish, carrying no
        // credentials and revealing nothing a diner in the room cannot see.
        // The JSON API keeps `same-site`.
        'Cross-Origin-Resource-Policy': 'cross-origin',
        // A year, because the address changes when the picture does. Without
        // the versioned URL this would have to be minutes, and a table of six
        // would re-download the whole menu between courses.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff'
      });

      // The point of the ETag: a phone that already has this photo is told so
      // in a few bytes instead of being sent the file again.
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      res.set('Content-Length', String(image.size_bytes));
      return res.send(image.bytes);
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

/**
 * The restaurant's own menu file, kept as-is.
 *
 * Distinct from `/ocr-extract`, which reads a menu in order to throw the file
 * away and keep the prices. This one keeps the file and shows it: a restaurant
 * whose menu is a designed PDF gets something in front of a diner immediately,
 * without anybody transcribing it first.
 *
 * It does not replace `menu_products`. A bill is built from priced rows, and
 * nothing here can be added to one -- the PDF is for reading.
 */
const PDF_MEDIA = 'application/pdf';

/** Metadata only. The bytes are large and the panel only needs to describe them. */
router.get('/pdf', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT restaurant_id, content_type, filename, size_bytes, updated_at
         FROM menu_documents WHERE restaurant_id = $1`,
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('MENU_PDF_NOT_FOUND', 'No menu file uploaded');
    res.json(dto.menuDocument(rows[0]));
  } catch (err) { next(err); }
});

router.put(
  '/pdf',
  requireRole('OWNER', 'MANAGER'),
  rateLimit({ windowSeconds: 300, max: 20, keyPrefix: 'menu:pdf' }),
  handleUpload(
    pdfUpload.single('file'), 'MENU_PDF_FILE_TOO_LARGE', config.menuPdf.maxUploadBytes
  ),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError('MENU_PDF_FILE_REQUIRED', 'A file is required');

      // The declared type is a claim by the client, so the bytes are checked
      // too: every PDF begins %PDF-. This is not a security boundary -- the
      // file is served back with its own Content-Type and never executed -- but
      // it catches the common mistake of uploading a photo of the menu here
      // rather than to the OCR route, and says so plainly.
      const declared = String(req.file.mimetype || '').split(';')[0].trim().toLowerCase();
      const looksPdf = req.file.buffer.subarray(0, 5).toString('latin1') === '%PDF-';
      if (declared !== PDF_MEDIA || !looksPdf) {
        throw new ApiError('MENU_PDF_UNSUPPORTED_MEDIA', 'Only PDF files are accepted', {
          contentType: declared || 'unknown'
        });
      }

      const { rows } = await db.query(
        `INSERT INTO menu_documents (restaurant_id, bytes, content_type, filename, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (restaurant_id) DO UPDATE
           SET bytes = EXCLUDED.bytes,
               content_type = EXCLUDED.content_type,
               filename = EXCLUDED.filename,
               size_bytes = EXCLUDED.size_bytes
         RETURNING restaurant_id, content_type, filename, size_bytes, updated_at`,
        [
          req.user.restaurantId,
          req.file.buffer,
          PDF_MEDIA,
          // A filename from a stranger, used only as a label and as the
          // download name. Stripped to its basename so nothing resembling a
          // path survives, and bounded so it cannot be a payload.
          String(req.file.originalname || 'carta.pdf').replace(/^.*[\\/]/, '').slice(0, 160),
          req.file.size
        ]
      );

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PDF_UPLOADED',
        resourceType: 'menu_document',
        resourceId: req.user.restaurantId
      });

      res.json(dto.menuDocument(rows[0]));
    } catch (err) { next(err); }
  }
);

router.delete('/pdf', requireRole('OWNER', 'MANAGER'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'DELETE FROM menu_documents WHERE restaurant_id = $1 RETURNING restaurant_id',
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('MENU_PDF_NOT_FOUND', 'No menu file uploaded');

    await logAudit({
      ...auditContext(req),
      action: 'MENU_PDF_DELETED',
      resourceType: 'menu_document',
      resourceId: req.user.restaurantId
    });

    res.status(204).end();
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
      `SELECT p.id, p.restaurant_id, p.name, p.description, p.price_minor_units, p.currency,
              p.category_id, p.position, p.active, p.created_at, p.updated_at,
              c.name AS category_name, ${IMAGE_COLUMNS}
         FROM menu_products p
         LEFT JOIN menu_categories c
           ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id
         ${IMAGE_JOIN}
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
 * The photograph of a dish.
 *
 * OWNER and MANAGER, the same pair that may write the product itself: a photo
 * is part of what a diner is sold, so it belongs with whoever sets the price
 * rather than with whoever carries the plates.
 *
 * An upsert, so replacing a photo is one request and there is never a second
 * row with a rule about which one wins. The product is looked up first and in
 * the same tenant, so an id from another restaurant is a 404 before any bytes
 * are read.
 */
router.put(
  '/products/:id/image',
  requireRole('OWNER', 'MANAGER'),
  validateParams(productIdParamSchema),
  rateLimit({ windowSeconds: 300, max: 60, keyPrefix: 'menu:image' }),
  handleUpload(
    imageUpload.single('file'), 'PRODUCT_IMAGE_FILE_TOO_LARGE', config.productImage.maxUploadBytes
  ),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError('PRODUCT_IMAGE_FILE_REQUIRED', 'A file is required');

      const declared = String(req.file.mimetype || '').split(';')[0].trim().toLowerCase();
      const looksRight = IMAGE_MEDIA[declared];
      if (!looksRight || !looksRight(req.file.buffer)) {
        throw new ApiError('PRODUCT_IMAGE_UNSUPPORTED_MEDIA', 'A photo must be JPEG, PNG or WebP', {
          contentType: declared || 'unknown',
          accepted: Object.keys(IMAGE_MEDIA)
        });
      }

      const product = await db.query(
        'SELECT id FROM menu_products WHERE id = $1 AND restaurant_id = $2',
        [req.params.id, req.user.restaurantId]
      );
      if (!product.rows.length) throw new ApiError('PRODUCT_NOT_FOUND', 'Product not found');

      // Hashed once, here, rather than on every request that serves the file --
      // see migration 033. It is both the ETag and the cache-busting suffix on
      // the URL, so replacing a photo replaces the address as well.
      const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

      // The write and the read that answers it, in one statement: the caller
      // needs the product back with `imageUrl` filled in, and RETURNING alone
      // cannot join to the section name or to the product row.
      const { rows } = await db.query(
        `WITH upserted AS (
           INSERT INTO menu_product_images
             (product_id, restaurant_id, bytes, content_type, size_bytes, checksum)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (product_id) DO UPDATE
             SET bytes = EXCLUDED.bytes,
                 content_type = EXCLUDED.content_type,
                 size_bytes = EXCLUDED.size_bytes,
                 checksum = EXCLUDED.checksum
           RETURNING product_id, restaurant_id, checksum
         )
         SELECT p.id, p.restaurant_id, p.name, p.description, p.price_minor_units,
                p.currency, p.category_id, p.position, p.active,
                p.created_at, p.updated_at,
                c.name AS category_name,
                true AS has_image, u.checksum AS image_checksum
           FROM upserted u
           JOIN menu_products p
             ON p.id = u.product_id AND p.restaurant_id = u.restaurant_id
           LEFT JOIN menu_categories c
             ON c.id = p.category_id AND c.restaurant_id = p.restaurant_id`,
        [
          req.params.id, req.user.restaurantId, req.file.buffer,
          declared, req.file.size, checksum
        ]
      );

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCT_IMAGE_UPLOADED',
        resourceType: 'menu_product',
        resourceId: req.params.id,
        details: { contentType: declared, sizeBytes: req.file.size }
      });

      // The product, not the file: the caller has the file already, and what it
      // needs back is the row with `imageUrl` filled in so the screen can show
      // the new photo without a second request.
      res.json(dto.product(rows[0]));
    } catch (err) { next(err); }
  }
);

/** Removes the photo and leaves the product alone. */
router.delete(
  '/products/:id/image',
  requireRole('OWNER', 'MANAGER'),
  validateParams(productIdParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `DELETE FROM menu_product_images
          WHERE product_id = $1 AND restaurant_id = $2
        RETURNING product_id`,
        [req.params.id, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('PRODUCT_IMAGE_NOT_FOUND', 'This product has no photo');

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCT_IMAGE_DELETED',
        resourceType: 'menu_product',
        resourceId: req.params.id
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
