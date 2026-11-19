/** Dishes: list, create, edit, reorder, delete. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const {
  validateBody,
  validateParams,
  validateQuery,
  deleteProductQuerySchema,
  createProductSchema,
  updateProductSchema,
  listProductsQuerySchema,
  productIdParamSchema,
  reorderProductsSchema
} = require('../../middleware/schemas');
const { logAudit, auditContext } = require('../../services/audit');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const { MENU_ORDER, IMAGE_COLUMNS, IMAGE_JOIN } = require('./shared');

const router = express.Router();

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
         w.category_id, w.position, w.active, w.tax_category, w.vat_bps,
         w.created_at, w.updated_at,
         c.name AS category_name,
         (pi.product_id IS NOT NULL) AS has_image, pi.checksum AS image_checksum
    FROM written w
    LEFT JOIN menu_categories c
      ON c.id = w.category_id AND c.restaurant_id = w.restaurant_id
    LEFT JOIN menu_product_images pi
      ON pi.product_id = w.id AND pi.restaurant_id = w.restaurant_id`;

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
              p.category_id, p.position, p.active, p.tax_category, p.vat_bps,
              p.created_at, p.updated_at,
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
            (restaurant_id, name, description, price_minor_units, currency, category_id, active,
             tax_category, vat_bps, position)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                  -- Al final de su sección. Con 0 se colaba por orden alfabético
                  -- entre los que el restaurante ya había ordenado a mano.
                  (SELECT COALESCE(MAX(position), -1) + 1 FROM menu_products
                    WHERE restaurant_id = $1 AND category_id IS NOT DISTINCT FROM $6::uuid))
          RETURNING *`),
        [
          req.user.restaurantId,
          req.body.name,
          req.body.description || null,
          req.body.priceMinorUnits,
          restaurant.rows[0].menu_currency,
          req.body.categoryId ?? null,
          req.body.active,
          req.body.taxCategory,
          // `undefined` y `null` acaban en lo mismo a propósito: un producto sin
          // alícuota propia va a la general del restaurante, y eso se guarda
          // como NULL y no como una copia del número de hoy.
          req.body.vatBps ?? null
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

/**
 * El orden de los platos dentro de una sección, entero de una vez.
 *
 * Igual que el de las secciones: `position` pasa a ser el índice en la lista,
 * en una sola sentencia y dentro de una transacción. La lista tiene que ser la
 * sección completa y sólo ella: un id de otra sección o de otro restaurante, o
 * uno que falte, deja la carta como estaba y responde 404. Aceptar una parte
 * dejaría dos platos con el mismo puesto y el orden decidido por el nombre,
 * que es justo lo que esto viene a quitar.
 */
router.put(
  '/products/order',
  requireRole('OWNER', 'MANAGER'),
  validateBody(reorderProductsSchema),
  async (req, res, next) => {
    try {
      const { categoryId, ids } = req.body;
      await db.withTransaction(async client => {
        const { rows: section } = await client.query(
          `SELECT id FROM menu_products
            WHERE restaurant_id = $1 AND category_id IS NOT DISTINCT FROM $2::uuid
            FOR UPDATE`,
          [req.user.restaurantId, categoryId]
        );
        const inSection = new Set(section.map(r => r.id));
        if (section.length !== ids.length || !ids.every(id => inSection.has(id))) {
          throw new ApiError('PRODUCT_NOT_FOUND', 'The list must be exactly the products of that section');
        }
        await client.query(
          `UPDATE menu_products AS p
              SET position = o.ordinality - 1
             FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, ordinality)
            WHERE p.id = o.id AND p.restaurant_id = $1`,
          [req.user.restaurantId, ids]
        );
      });

      await logAudit({
        ...auditContext(req),
        action: 'MENU_PRODUCTS_REORDERED',
        resourceType: 'menu_category',
        resourceId: categoryId
      });

      res.status(204).end();
    } catch (err) { next(err); }
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
      // `vatBps` tiene el mismo problema que `categoryId` y una vuelta más.
      //
      // Lo mismo: `null` es un valor -- «vuelve a la alícuota general» -- y
      // COALESCE no sabe distinguirlo de un campo que no se mandó.
      //
      // La vuelta de más: declarar exento un producto que tenía alícuota propia
      // dejaría una contradicción que el CHECK de la base rechaza. Cuando quien
      // llama cambia la categoría a una no gravada y **no** menciona la
      // alícuota, se limpia sola: es lo que significa el cambio. Si la menciona
      // y contradice a la categoría, salta el CHECK y se traduce abajo a un
      // error legible, en vez de guardarle en silencio algo que no pidió.
      const setsVatBps = Object.prototype.hasOwnProperty.call(req.body, 'vatBps');
      const { rows } = await db.query(
        withCategoryName(`
          UPDATE menu_products
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 price_minor_units = COALESCE($3, price_minor_units),
                 active = COALESCE($4, active),
                 category_id = CASE WHEN $5::boolean THEN $6::uuid ELSE category_id END,
                 -- Cambiar de sección lo manda al final de la nueva: su puesto
                 -- en la vieja no significa nada allí. En el SET, category_id
                 -- todavía es el de antes.
                 position = CASE
                   WHEN $5::boolean AND category_id IS DISTINCT FROM $6::uuid THEN
                     (SELECT COALESCE(MAX(m.position), -1) + 1 FROM menu_products m
                       WHERE m.restaurant_id = $8 AND m.category_id IS NOT DISTINCT FROM $6::uuid)
                   ELSE position
                 END,
                 tax_category = COALESCE($9, tax_category),
                 vat_bps = CASE
                   WHEN $10::boolean THEN $11::integer
                   WHEN COALESCE($9, tax_category) <> 'TAXABLE' THEN NULL
                   ELSE vat_bps
                 END
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
          req.user.restaurantId,
          req.body.taxCategory ?? null,
          setsVatBps,
          req.body.vatBps ?? null
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
      // Ponerle alícuota propia a un producto que ya estaba exento. El esquema
      // atrapa la contradicción cuando llegan los dos campos juntos; cuando
      // sólo llega la alícuota, la categoría que la contradice es la que estaba
      // guardada, y quien lo sabe es la base. Se traduce aquí porque un 23514
      // en crudo no le dice a nadie qué hacer.
      if (err.code === '23514' && String(err.constraint) === 'menu_products_vat_only_when_taxable') {
        return next(new ApiError(
          'PRODUCT_TAX_CONFLICT',
          'Only a TAXABLE product can carry its own vatBps; change taxCategory first'
        ));
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
