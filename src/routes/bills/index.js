/**
 * /api/v1/bills: staff work on a bill, from opening it to settling it.
 *
 * Split by job (R18) out of one 860-line file. Every route still sits behind
 * the two router-wide middlewares below -- staff auth and the bills rate
 * limit -- because they run here, before any sub-router.
 */
const express = require('express');
const config = require('../../config');
const { authenticateToken } = require('../../middleware/auth');
const rateLimit = require('../../middleware/rateLimit');

const router = express.Router();

router.use(authenticateToken);

// Mounted *after* authentication so the bucket keys on req.user.sub. The
// app-level limiter runs before any auth middleware, which leaves it keyed on
// IP alone — behind carrier NAT that is one shared bucket for many staff.
router.use(rateLimit({ windowSeconds: 60, max: config.rateLimit.billsMax, keyPrefix: 'bills' }));

router.use(require('./read'));

router.use(require('./open'));

router.use(require('./items'));

router.use(require('./splits'));

router.use(require('./settle'));

module.exports = router;
