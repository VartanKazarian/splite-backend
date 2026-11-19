/** Pictures: a dish's photo and the restaurant's branding. */
const express = require('express');
const crypto = require('node:crypto');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const {
  validateParams,
  productIdParamSchema,
  brandingKindParamSchema
} = require('../../middleware/schemas');
const { logAudit, auditContext } = require('../../services/audit');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const config = require('../../config');
const rateLimit = require('../../middleware/rateLimit');
const multer = require('multer');
const { MULTIPART_LIMITS, handleUpload } = require('./shared');

const router = express.Router();

/**
 * A dish photo. Its own limit again, and the smallest of the three: this file
 * is fetched by every diner at the table rather than by one person who chose to
 * open it.
 */
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...MULTIPART_LIMITS, fileSize: config.productImage.maxUploadBytes }
});

/** The cover and the logo. A little more headroom than a dish photo. */
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { ...MULTIPART_LIMITS, fileSize: config.branding.maxUploadBytes }
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
                p.tax_category, p.vat_bps,
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
 * The restaurant's cover photo and logo.
 *
 * OWNER and MANAGER, the same pair that may rename the restaurant: this is the
 * shopfront a diner sees after scanning, and it is not a decision for whoever
 * is carrying plates.
 *
 * One route for both kinds rather than two nearly identical ones. They differ
 * in where a client puts them, not in anything this has to do.
 */
router.put(
  '/branding/:kind',
  requireRole('OWNER', 'MANAGER'),
  validateParams(brandingKindParamSchema),
  rateLimit({ windowSeconds: 300, max: 30, keyPrefix: 'menu:brand' }),
  handleUpload(
    brandingUpload.single('file'), 'BRANDING_FILE_TOO_LARGE', config.branding.maxUploadBytes
  ),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ApiError('BRANDING_FILE_REQUIRED', 'A file is required');

      const declared = String(req.file.mimetype || '').split(';')[0].trim().toLowerCase();
      const looksRight = IMAGE_MEDIA[declared];
      if (!looksRight || !looksRight(req.file.buffer)) {
        throw new ApiError('BRANDING_UNSUPPORTED_MEDIA', 'An image must be JPEG, PNG or WebP', {
          contentType: declared || 'unknown',
          accepted: Object.keys(IMAGE_MEDIA)
        });
      }

      const checksum = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const { rows } = await db.query(
        `INSERT INTO restaurant_images
           (restaurant_id, kind, bytes, content_type, size_bytes, checksum)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (restaurant_id, kind) DO UPDATE
           SET bytes = EXCLUDED.bytes,
               content_type = EXCLUDED.content_type,
               size_bytes = EXCLUDED.size_bytes,
               checksum = EXCLUDED.checksum
         RETURNING restaurant_id, kind, content_type, size_bytes, checksum`,
        [
          req.user.restaurantId, req.params.kind, req.file.buffer,
          declared, req.file.size, checksum
        ]
      );

      await logAudit({
        ...auditContext(req),
        action: 'RESTAURANT_BRANDING_UPLOADED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { kind: req.params.kind, contentType: declared, sizeBytes: req.file.size }
      });

      res.json(dto.brandingImage(rows[0]));
    } catch (err) { next(err); }
  }
);

router.delete(
  '/branding/:kind',
  requireRole('OWNER', 'MANAGER'),
  validateParams(brandingKindParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'DELETE FROM restaurant_images WHERE restaurant_id = $1 AND kind = $2 RETURNING kind',
        [req.user.restaurantId, req.params.kind]
      );
      if (!rows.length) throw new ApiError('BRANDING_NOT_FOUND', 'This restaurant has no image of that kind');

      await logAudit({
        ...auditContext(req),
        action: 'RESTAURANT_BRANDING_DELETED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { kind: req.params.kind }
      });

      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
