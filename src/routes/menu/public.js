/** The menu as a diner's phone reads it: no staff session, keyed by restaurant. */
const express = require('express');
const db = require('../../connectors/base');
const fxService = require('../../services/fx');
const {
  validateParams,
  restaurantIdParamSchema,
  productImageParamSchema,
  publicBrandingParamSchema
} = require('../../middleware/schemas');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const rateLimit = require('../../middleware/rateLimit');
const { MENU_ORDER, IMAGE_COLUMNS, IMAGE_JOIN } = require('./shared');

const router = express.Router();

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
      // The branding checksums come along, never the bytes: they only become a
      // URL. See `brandingUrls` for why the checksum is on the query string.
      const restaurant = await db.query(
        `SELECT r.id, r.name, r.menu_currency,
                cover.checksum AS cover_checksum,
                logo.checksum  AS logo_checksum
           FROM restaurants r
           LEFT JOIN restaurant_images cover
             ON cover.restaurant_id = r.id AND cover.kind = 'COVER'
           LEFT JOIN restaurant_images logo
             ON logo.restaurant_id = r.id AND logo.kind = 'LOGO'
          WHERE r.id = $1 AND r.active = true`,
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

      // La tasa en vigor, para que el comensal vea cuánto es en bolívares una
      // carta en dólares: paga en bolívares, y hacer la cuenta de cabeza a 757
      // por dólar no lo hace nadie en la mesa. Es una referencia -- la cuenta
      // se cobra a la tasa de cuando se abre --, y `getRateFor` nunca lanza:
      // sin tasa, la carta sale igual, sólo que sin el equivalente.
      const currency = restaurant.rows[0].menu_currency;
      const quote = currency && currency !== 'VES' ? await fxService.getRateFor(currency) : null;

      res.json({
        restaurant: dto.menuSettings(restaurant.rows[0]),
        rate: quote && quote.rate
          ? { currency, rate: Number(quote.rate).toFixed(8), valueDate: quote.valueDate ?? null }
          : null,
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
  // Por dirección, y la dirección es el wifi del local: diez comensales que
  // abren una carta de cuarenta fotos son cuatrocientas peticiones en un
  // minuto, aunque cada teléfono las guarde después un año. Con 240 se
  // quedaban platos sin foto justo en la hora punta.
  rateLimit({ windowSeconds: 60, max: 1200, keyPrefix: 'menu:imgpub' }),
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

/**
 * The restaurant's cover photo or logo, to whoever is holding the QR menu.
 *
 * Unauthenticated, like everything else under `/public`: these are the images
 * the restaurant chose to put on its own front page.
 *
 * Cached and served exactly like a dish photo, including the
 * `Cross-Origin-Resource-Policy` override -- the panel and the API are
 * different sites in every deployment we have, and without it the browser
 * fetches the image and then refuses to render it. See the product image route
 * below for the long version.
 */
router.get(
  '/public/:restaurantId/branding/:kind',
  validateParams(publicBrandingParamSchema),
  rateLimit({ windowSeconds: 60, max: 1200, keyPrefix: 'menu:brandpub' }),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT i.bytes, i.content_type, i.size_bytes, i.checksum, i.updated_at
           FROM restaurant_images i
           JOIN restaurants r ON r.id = i.restaurant_id
          WHERE i.restaurant_id = $1 AND i.kind = $2 AND r.active = true`,
        [req.params.restaurantId, req.params.kind]
      );
      const image = rows[0];
      if (!image) throw new ApiError('BRANDING_NOT_FOUND', 'This restaurant has no image of that kind');

      const etag = `"${image.checksum}"`;
      res.set({
        'Content-Type': image.content_type,
        ETag: etag,
        'Last-Modified': new Date(image.updated_at).toUTCString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'X-Content-Type-Options': 'nosniff'
      });
      if (req.headers['if-none-match'] === etag) return res.status(304).end();

      res.set('Content-Length', String(image.size_bytes));
      return res.send(image.bytes);
    } catch (err) { next(err); }
  }
);

module.exports = router;
