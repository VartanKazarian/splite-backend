const express = require('express');
const db = require('../connectors/base');
const config = require('../config');
const { signQrPayload, verifyQrToken } = require('../utils/tokens');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody, validateParams, guestSessionSchema, tableIdParamSchema, splitPreviewSchema,
  declareClaimSchema
} = require('../middleware/schemas');
const { createGuestSession, destroyGuestSession, authenticateGuest } = require('../services/guest');
const billItems = require('../services/billItems');
const paymentClaims = require('../services/paymentClaims');
const splitEngine = require('../services/splitEngine');
const dto = require('../dto');
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

/**
 * The open bill for the guest's own table.
 *
 * Note what this route does not take: a bill id. The table comes from the
 * session, which came from a signed QR, so a guest cannot ask for a bill that
 * is not theirs -- there is no identifier to tamper with. Every guest route
 * below is built the same way.
 */
async function openBillForGuest(guest) {
  const { rows } = await db.query(
    `SELECT id, table_id, status, currency, total_due,
            subtotal_minor, vat_bps, vat_minor,
            service_charge_bps, service_charge_minor,
            total_due_ves, amount_paid_ves,
            fx_rate_ves_per_unit, updated_at
       FROM bills
      WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'`,
    [guest.restaurantId, guest.tableId]
  );
  if (!rows.length) throw new ApiError('OPEN_BILL_NOT_FOUND', 'No open bill for this table');
  return rows[0];
}

router.get('/bill', authenticateGuest, async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const items = await billItems.listForBill({
      restaurantId: req.guest.restaurantId, billId: bill.id
    });
    res.json(dto.guestBill(bill, items));
  } catch (err) { next(err); }
});

/**
 * "I paid by Pago Móvil, here is my reference."
 *
 * Creates a claim and settles nothing. The money moved between the diner's bank
 * and the restaurant's without passing through Splite, so no API of ours can
 * see it arrive -- the only honest thing this endpoint can do is carry the
 * diner's word to a person who can check the bank app.
 *
 * `bills.amount_paid_ves` is untouched until that person confirms. A bill that
 * showed itself as paid because somebody typed a number into a form would be
 * worse than one that shows nothing, because the restaurant would stop asking.
 *
 * Takes no bill id, like every guest route: the table comes from the session.
 */
router.post('/bill/payment-claims', authenticateGuest, validateBody(declareClaimSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const claim = await paymentClaims.declareClaim({
      restaurantId: req.guest.restaurantId,
      billId: bill.id,
      amountVes: req.body.amountVes,
      reference: req.body.reference,
      phoneOrigin: req.body.phoneOrigin,
      bankOrigin: req.body.bankOrigin,
      payer: { type: 'GUEST', id: null },
      meta: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id }
    });

    res.status(201).json(dto.paymentClaim(claim));
  } catch (err) { next(err); }
});

/**
 * A split of the guest's own bill.
 *
 * The same engine the staff endpoint uses, so a diner and a waiter looking at
 * the same bill are never shown two different allocations. Advisory: it
 * computes and returns, and moves no money.
 */
router.post('/bill/split/preview', authenticateGuest, validateBody(splitPreviewSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const items = req.body.mode === 'ITEMS'
      ? await billItems.listForBill({ restaurantId: req.guest.restaurantId, billId: bill.id })
      : [];

    res.json(splitEngine.preview({ bill, items, request: req.body }));
  } catch (err) { next(err); }
});

/**
 * Ends the session.
 *
 * Always 204, whether or not the session existed, so it never reports back
 * whether a given session id was live.
 */
router.delete('/sessions', authenticateGuest, async (req, res, next) => {
  try {
    await destroyGuestSession(req.guest.sessionId);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
