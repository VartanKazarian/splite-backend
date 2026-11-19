/** A table's QR: printing it, rotating it, and what a scan says about the table. */
const express = require('express');
const db = require('../../connectors/base');
const config = require('../../config');
const { signQrPayload } = require('../../utils/tokens');
const { authenticateToken, requireRole } = require('../../middleware/auth');
const {
  validateBody,
  validateParams,
  guestSessionSchema,
  tableIdParamSchema
} = require('../../middleware/schemas');
const rateLimit = require('../../middleware/rateLimit');
const dto = require('../../dto');
const { logAudit, auditContext } = require('../../services/audit');
const { ApiError } = require('../../errors');
const { tableForQr } = require('./shared');

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

      // A permanent code must be *stable*, not merely long-lived: the same
      // table and nonce have to produce the same token every time, or the QR
      // on screen differs from the one already stuck to the table and changes
      // on every refresh.
      //
      // That means no `iat`. Verification never reads it, so it bought nothing
      // and made the token a function of the clock. With it gone the token is a
      // pure function of (table, restaurant, nonce, secret), and the only thing
      // that changes it is rotating the nonce -- which is exactly what revoking
      // a printed code should mean.
      //
      // A configured TTL is the other case: those codes are time-bounded by
      // design, so they carry iat and exp and are expected to differ per mint.
      const ttl = config.qrTtlSeconds;
      const now = Math.floor(Date.now() / 1000);
      const token = signQrPayload({
        v: 1,
        tableId: table.id,
        restaurantId: table.restaurant_id,
        nonce: table.qr_nonce,
        ...(ttl > 0 ? { iat: now, exp: now + ttl } : {})
      });

      await logAudit({
        ...auditContext(req),
        action: 'QR_ISSUED',
        resourceType: 'table',
        resourceId: table.id
      });

      res.json({ token, expiresIn: ttl > 0 ? ttl : null });
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

/**
 * Public: what a scanned code points at, without opening anything.
 *
 * A printed QR used to have exactly one thing it could do -- mint a session --
 * so a diner who scanned it to read the menu got a session anyway, and the
 * menu was unreachable regardless: `GET /menu/public/:restaurantId/products`
 * needs a restaurant id, and until this route there was no way to learn one
 * without first taking a session. The two things a person does at a table were
 * behind the same door.
 *
 * So this is the landing: enough to say which restaurant and which table, and
 * enough to fetch the public menu. A session is minted only by the diner who
 * asks for the bill.
 *
 * POST rather than GET, unlike the rest of the read surface. The token would
 * otherwise sit in `req.url`, which the access log records on every request --
 * see the pino-http serializer in app.js. It is a low-value credential printed
 * on a table in a public room, but there is no reason to copy it into every
 * log line to save a verb.
 *
 * Returns nothing about money. `hasOpenBill` is the one fact the landing needs
 * -- whether to offer the bill at all -- and it says only what anyone standing
 * in the room can see. What the table owes stays behind the session.
 */
router.post(
  '/qr/context',
  rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'guest:qrctx' }),
  validateBody(guestSessionSchema),
  async (req, res, next) => {
    try {
      const table = await tableForQr(req.body.qrToken);

      const { rows } = await db.query(
        `SELECT 1 FROM bills
          WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN' LIMIT 1`,
        [table.restaurant_id, table.id]
      );

      res.json(dto.qrContext(table, { hasOpenBill: rows.length > 0 }));
    } catch (err) { next(err); }
  }
);

module.exports = router;
