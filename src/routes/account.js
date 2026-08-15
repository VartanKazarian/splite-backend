const express = require('express');
const db = require('../connectors/base');
const { authenticateToken } = require('../middleware/auth');
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
              plan_tier, trial_ends_at, created_at
         FROM restaurants
        WHERE id = $1`,
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

    res.json(dto.account(rows[0]));
  } catch (err) { next(err); }
});

module.exports = router;
