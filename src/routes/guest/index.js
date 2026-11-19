/**
 * /api/v1/guest: everything a diner's phone does, from scanning the QR to
 * paying, plus the staff routes that print and rotate a table's QR.
 *
 * Split by job (R18) out of one 1,000-line file. There is no router-wide
 * middleware here: each route names its own (guest auth, the per-session
 * limiter), so the order the sub-routers are mounted in changes nothing.
 */
const express = require('express');

const router = express.Router();

router.use(require('./qr'));

router.use(require('./sessions'));

router.use(require('./payments'));

router.use(require('./bill'));

router.use(require('./pay'));

router.use(require('./splits'));

module.exports = router;
