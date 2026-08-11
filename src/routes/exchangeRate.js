const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getRates } = require('../services/fx');
const { ApiError } = require('../errors');

const router = express.Router();

/**
 * Official BCV reference rates, USD and EUR, published together.
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
    const rates = await getRates();
    if (Object.keys(rates).length === 0) {
      throw new ApiError('FX_UNAVAILABLE', 'No exchange rate is available');
    }
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      // BCV publishes USD and EUR on the same page with the same value date; a
      // restaurant may price its menu in either.
      rates: Object.fromEntries(Object.entries(rates).map(([currency, r]) => [currency, {
        rate: Number(r.rate).toFixed(8),
        valueDate: r.valueDate,
        source: r.source,
        fetchedAt: r.fetchedAt instanceof Date ? r.fetchedAt.toISOString() : r.fetchedAt
      }]))
    });
  } catch (err) { next(err); }
});

module.exports = router;
