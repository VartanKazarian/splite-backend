/**
 * /api/v1/menu: the restaurant's menu, as diners read it and as staff edit it.
 *
 * Split by job (R18) out of one 1,600-line file. The order of the mounts below
 * is load-bearing: the public routes come before `authenticateToken`, so a
 * diner's phone reads the menu without a staff session, and everything after
 * it requires one.
 */
const express = require('express');
const { authenticateToken } = require('../../middleware/auth');

const router = express.Router();

router.use(require('./public'));

// Everything below is staff-only.
router.use(authenticateToken);

router.use(require('./settings'));

router.use(require('./categories'));

router.use(require('./pdf'));

router.use(require('./products'));

router.use(require('./images'));

router.use(require('./ocr'));

module.exports = router;
