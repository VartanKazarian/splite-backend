const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateBody, payoutSchema } = require('../middleware/schemas');
const { logAudit, auditContext } = require('../services/audit');
const banks = require('../payments/banks');
const { ApiError } = require('../errors');
const dto = require('../dto');

const router = express.Router();
router.use(authenticateToken);

/**
 * The signed-in restaurant's own record: who it is, and what it is paying for.
 *
 * This exists so that `plan_tier` and `trial_ends_at` are read by something.
 * A column nothing consults is a column that quietly stops being true, and a
 * trial nobody can see is a trial that expires without warning.
 *
 * Note what it does *not* do: nothing here refuses service when the trial ends.
 * Which action a lapsed restaurant loses is a pricing decision, and the obvious
 * candidate is the wrong one -- cutting off bills mid-service strands a dining
 * room full of seated customers over an unpaid invoice. Until that decision is
 * made deliberately, the dates are reported and the frontend warns.
 */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, rif, menu_currency, vat_bps, service_charge_bps,
              payout_bank_code, payout_account_number, payout_phone, payout_holder_id,
              plan_tier, trial_ends_at, created_at
         FROM restaurants
        WHERE id = $1`,
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

    res.json(dto.account(rows[0]));
  } catch (err) { next(err); }
});

/**
 * The banks a payee can be configured against.
 *
 * `chargeable` is the honest half: a restaurant may name any bank, because that
 * is where diners send money whether or not we have an integration, but only a
 * bank with a module can take part in an in-app payment. Nothing is chargeable
 * yet, and the field says so rather than the frontend assuming.
 */
router.get('/banks', (req, res) => {
  res.json({ data: banks.list() });
});

/**
 * Where the restaurant is paid.
 *
 * OWNER and MANAGER only. This is the address money is sent to: getting it
 * wrong does not degrade the product, it pays a stranger, and that is not a
 * change a waiter should be able to make from the floor.
 *
 * Sending `{}` clears it -- the schema requires all four fields together or
 * none, matching the database, because a half-filled payee looks configured on
 * screen and cannot receive money.
 */
router.put(
  '/payout',
  requireRole('OWNER', 'MANAGER'),
  validateBody(payoutSchema),
  async (req, res, next) => {
    try {
      const { bankCode, accountNumber, phone, holderId } = req.body;
      // Digits only, so the same number typed three ways is one value and can
      // be compared against what a bank reports.
      const normalisedPhone = phone ? String(phone).replace(/\D/g, '') : null;

      const { rows } = await db.query(
        `UPDATE restaurants
            SET payout_bank_code = $2, payout_account_number = $3,
                payout_phone = $4, payout_holder_id = $5, updated_at = NOW()
          WHERE id = $1
        RETURNING id, name, rif, menu_currency, vat_bps, service_charge_bps,
                  payout_bank_code, payout_account_number, payout_phone, payout_holder_id,
                  plan_tier, trial_ends_at, created_at`,
        [req.user.restaurantId, bankCode ?? null, accountNumber ?? null,
         normalisedPhone, holderId ?? null]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      await logAudit({
        ...auditContext(req),
        action: bankCode ? 'PAYOUT_DETAILS_UPDATED' : 'PAYOUT_DETAILS_CLEARED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        // The bank and the holder, never the account number: an audit log is
        // read by more people, and kept longer, than the row it describes.
        details: { bankCode: bankCode ?? null, holderId: holderId ?? null }
      });

      res.json(dto.account(rows[0]));
    } catch (err) { next(err); }
  }
);

module.exports = router;
