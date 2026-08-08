const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { getVesPerUsd } = require('../services/exchangeRate');

const router = express.Router();

/**
 * Official BCV USD rate.
 *
 * Staff-only for now. Guests will need this too once guest bill access lands,
 * at which point authenticateGuest can be accepted alongside the staff token —
 * the value itself is public information published by the central bank.
 */
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const rate = await getVesPerUsd();
    // A stale rate is still worth serving, but the caller must be able to tell:
    // during a BCV outage this is yesterday's number.
    res.set('Cache-Control', 'public, max-age=60');
    res.json(rate);
  } catch (err) { next(err); }
});

module.exports = router;
