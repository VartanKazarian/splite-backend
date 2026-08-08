const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getUsdToVesRate } = require('../services/fx');

const router = express.Router();

/**
 * Official BCV USD reference rate.
 *
 * Settlement is always VES, so this is a display aid. It returns 503 when no
 * verified rate is available rather than guessing — but note that a payment
 * never depends on this endpoint: an FX outage omits the USD line and money
 * still moves.
 *
 * Staff-only for now. Guests will need it once guest bill access lands, at
 * which point authenticateGuest can be accepted alongside the staff token —
 * the value itself is public information published by the central bank.
 */
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const rate = await getUsdToVesRate();
    if (!rate) {
      return res.status(503).json({ error: 'Exchange rate is unavailable' });
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      rate: rate.rate,
      valueDate: rate.valueDate,
      source: rate.source,
      fetchedAt: rate.fetchedAt instanceof Date ? rate.fetchedAt.toISOString() : rate.fetchedAt
    });
  } catch (err) { next(err); }
});

module.exports = router;
