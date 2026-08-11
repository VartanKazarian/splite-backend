const express = require('express');
const db = require('../connectors/base');
const config = require('../config');
const { signQrPayload, verifyQrToken } = require('../utils/tokens');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateBody, validateParams, guestSessionSchema, tableIdParamSchema } = require('../middleware/schemas');
const { createGuestSession } = require('../services/guest');
const { logAudit, auditContext } = require('../services/audit');
const { ApiError } = require('../errors');

const router = express.Router();

/**
 * Staff-only QR issuance. The table lookup is tenant-scoped: without the
 * restaurant_id predicate an owner of restaurant A could mint a valid QR for a
 * table belonging to restaurant B.
 */
router.get(
  '/tables/:tableId/qr',
  authenticateToken,
  requireRole('OWNER', 'MANAGER'),
  validateParams(tableIdParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true',
        [req.params.tableId, req.user.restaurantId]
      );
      const table = rows[0];
      if (!table) throw new ApiError('TABLE_NOT_FOUND', 'Table not found');

      const now = Math.floor(Date.now() / 1000);
      const token = signQrPayload({
        v: 1,
        tableId: table.id,
        restaurantId: table.restaurant_id,
        nonce: table.qr_nonce,
        iat: now,
        exp: now + config.qrTtlSeconds
      });

      await logAudit({
        ...auditContext(req),
        action: 'QR_ISSUED',
        resourceType: 'table',
        resourceId: table.id
      });

      res.json({ token, expiresIn: config.qrTtlSeconds });
    } catch (err) { next(err); }
  }
);

/**
 * Rotating a table's nonce invalidates every QR previously printed for it.
 */
router.post(
  '/tables/:tableId/qr/rotate',
  authenticateToken,
  requireRole('OWNER', 'MANAGER'),
  validateParams(tableIdParamSchema),
  async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'UPDATE tables SET qr_nonce = gen_random_uuid() WHERE id = $1 AND restaurant_id = $2 RETURNING id',
        [req.params.tableId, req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('TABLE_NOT_FOUND', 'Table not found');
      await logAudit({ ...auditContext(req), action: 'QR_ROTATED', resourceType: 'table', resourceId: rows[0].id });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

/** Public: exchanges a signed QR token for a short-lived guest session. */
router.post('/sessions', validateBody(guestSessionSchema), async (req, res, next) => {
  try {
    let payload;
    try {
      payload = verifyQrToken(req.body.qrToken);
    } catch {
      throw new ApiError('QR_INVALID', 'Invalid table QR');
    }

    const { rows } = await db.query(
      'SELECT id, restaurant_id, qr_nonce, active FROM tables WHERE id = $1 AND restaurant_id = $2',
      [payload.tableId, payload.restaurantId]
    );
    const table = rows[0];
    // Nonce check makes a reprinted/rotated QR immediately unusable.
    if (!table || !table.active || String(table.qr_nonce) !== String(payload.nonce)) {
      throw new ApiError('QR_INVALID', 'Invalid table QR');
    }

    const session = await createGuestSession({
      restaurantId: table.restaurant_id,
      tableId: table.id,
      ip: req.ip,
      userAgent: req.get('user-agent')
    });

    await logAudit({
      action: 'GUEST_SESSION_CREATED',
      restaurantId: table.restaurant_id,
      resourceType: 'table',
      resourceId: table.id,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      requestId: req.id
    });

    res.status(201).json(session);
  } catch (err) { next(err); }
});

module.exports = router;
