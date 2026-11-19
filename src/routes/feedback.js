const express = require('express');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateQuery, feedbackQuerySchema } = require('../middleware/schemas');
const feedback = require('../services/feedback');

/**
 * Lo que opinan los comensales (R20): dueño y encargado, que son quienes
 * pueden hacer algo con ello.
 */
const router = express.Router();

router.use(authenticateToken);

router.get('/', requireRole('OWNER', 'MANAGER'), validateQuery(feedbackQuerySchema), async (req, res, next) => {
  try {
    res.json(await feedback.summary({ restaurantId: req.user.restaurantId, days: req.query.days }));
  } catch (err) { next(err); }
});

module.exports = router;
