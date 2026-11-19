/** Menu settings: the quoting currency and the service and VAT charges. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const { validateBody, menuCurrencySchema, menuChargesSchema } = require('../../middleware/schemas');
const { logAudit, auditContext } = require('../../services/audit');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const menuOcr = require('../../services/menuOcr');

const router = express.Router();

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

module.exports = router;
