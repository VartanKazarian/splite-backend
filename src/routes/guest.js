const express = require('express');
const db = require('../connectors/base');
const config = require('../config');
const { signQrPayload, verifyQrToken } = require('../utils/tokens');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody, validateParams, validateQuery, guestSessionSchema, tableIdParamSchema, splitPreviewSchema,
  declareClaimSchema, c2pChargeSchema, c2pBankGuideQuerySchema
} = require('../middleware/schemas');
const { createGuestSession, destroyGuestSession, authenticateGuest } = require('../services/guest');
const rateLimit = require('../middleware/rateLimit');
const billItems = require('../services/billItems');
const paymentClaims = require('../services/paymentClaims');
const mercantilC2P = require('../services/mercantilC2P');
const claveGuide = require('../payments/c2pClaveGuide');
const { requestHash, begin, complete, abort } = require('../services/idempotency');
const { logger } = require('../connectors/logger');
const splitEngine = require('../services/splitEngine');
const splits = require('../services/splits');
const dto = require('../dto');
const { logAudit, auditContext } = require('../services/audit');
const { ApiError } = require('../errors');

const router = express.Router();

/**
 * The real guest limit, mounted after authenticateGuest so the bucket keys on
 * the session rather than the address.
 *
 * The app-level limiter on /api/v1/guest runs before any of this and can only
 * see an IP, which on the diner-facing surface identifies a carrier NAT rather
 * than a person: one bucket for every table in the room. One diner refreshing
 * hard is now throttled and the table next to them is not.
 */
// NOT 'guest:session': that is the prefix the sessions themselves are stored
// under, so the counter and the credential would be the same Redis key. INCR on
// a key holding JSON errors, the limiter treats that as its backend being
// unavailable and fails open, and per-session limiting silently does nothing.
const perSession = rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'guest:rl' });

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
 * The table a QR token names, or an error.
 *
 * Shared by the two public routes that accept a printed code, because the
 * checks are the whole of its security and a second copy is a second place for
 * one of them to go missing: the HMAC, the tenant-scoped lookup, `active`, and
 * the nonce -- which is what makes a reprinted or rotated code stop working.
 *
 * Every failure is the same `QR_INVALID`. A code stuck to a table is read by
 * strangers, and distinguishing "no such table" from "wrong nonce" would answer
 * questions about a restaurant to somebody holding a photograph of its
 * furniture.
 */
async function tableForQr(qrToken) {
  let payload;
  try {
    payload = verifyQrToken(qrToken);
  } catch {
    throw new ApiError('QR_INVALID', 'Invalid table QR');
  }

  const { rows } = await db.query(
    `SELECT t.id, t.restaurant_id, t.name, t.qr_nonce, t.active,
            r.name AS restaurant_name, r.menu_currency, r.active AS restaurant_active,
            cover.checksum AS cover_checksum, logo.checksum AS logo_checksum
       FROM tables t
       JOIN restaurants r ON r.id = t.restaurant_id
       LEFT JOIN restaurant_images cover
         ON cover.restaurant_id = r.id AND cover.kind = 'COVER'
       LEFT JOIN restaurant_images logo
         ON logo.restaurant_id = r.id AND logo.kind = 'LOGO'
      WHERE t.id = $1 AND t.restaurant_id = $2`,
    [payload.tableId, payload.restaurantId]
  );
  const table = rows[0];
  if (!table || !table.active || !table.restaurant_active ||
      String(table.qr_nonce) !== String(payload.nonce)) {
    throw new ApiError('QR_INVALID', 'Invalid table QR');
  }
  return table;
}

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

/**
 * Public: exchanges a signed QR token for a short-lived guest session.
 *
 * Minting is the one guest route with no credential to count per, so it stays
 * keyed on the address. Sized for a restaurant on one connection rather than
 * for one phone: diners on the venue WiFi all arrive from the same address, and
 * a wave of tables scanning at the end of service is normal traffic.
 *
 * Not fail-closed, unlike /auth. There the limiter is what stands between an
 * attacker and a password; here the gate is the HMAC on the QR, and this is
 * only bounding volume. Refusing every diner in the building because Redis
 * blinked would be choosing an outage over a rate limit.
 */
router.post(
  '/sessions',
  rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'guest:mint' }),
  validateBody(guestSessionSchema),
  async (req, res, next) => {
    try {
      // Same checks as /qr/context, from one place: the nonce is what makes a
      // reprinted or rotated code stop working, and it must not be possible for
      // one route to keep honouring a code the other has stopped honouring.
      const table = await tableForQr(req.body.qrToken);

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
  }
);

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

/**
 * Who the diner is actually paying.
 *
 * Splite never holds the money -- a Pago Móvil goes from the diner's account to
 * the restaurant's -- so without this the bill screen can show what is owed and
 * offer no way to pay it. Bank, phone and identity document, which is what
 * addressing a Pago Móvil takes; the account number stays behind the staff
 * surface.
 */
async function payeeForGuest(guest) {
  const { rows } = await db.query(
    `SELECT payout_bank_code, payout_phone, payout_holder_id
       FROM restaurants WHERE id = $1`,
    [guest.restaurantId]
  );
  return rows[0] ? dto.guestPayee(rows[0]) : null;
}

router.get('/bill', authenticateGuest, perSession, async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const [items, payee] = await Promise.all([
      billItems.listForBill({ restaurantId: req.guest.restaurantId, billId: bill.id }),
      payeeForGuest(req.guest)
    ]);
    res.json({ ...dto.guestBill(bill, items), payee });
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
router.post('/bill/payment-claims', authenticateGuest, perSession, validateBody(declareClaimSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const claim = await paymentClaims.declareClaim({
      restaurantId: req.guest.restaurantId,
      billId: bill.id,
      amountVes: req.body.amountVes,
      reference: req.body.reference,
      phoneOrigin: req.body.phoneOrigin,
      bankOrigin: req.body.bankOrigin,
      idOrigin: req.body.idOrigin,
      payer: { type: 'GUEST', id: null },
      splitParticipantId: req.body.splitParticipantId ?? null,
      tipVes: req.body.tipVes ?? '0',
      meta: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id }
    });

    res.status(201).json(dto.paymentClaim(claim));
  } catch (err) { next(err); }
});

/**
 * How to obtain a C2P clave, for every bank Splite can charge.
 *
 * The step of the C2P flow Splite does not control: the diner asks their own
 * bank for a single-use clave. This is static reference data -- channels, SMS
 * short codes and bodies, and how long the clave lives -- so the app can show
 * the exact instruction for the chosen bank instead of a generic prompt that
 * strands a Banplus customer hunting an SMS code that does not exist.
 *
 * The `strategy` on each bank is the part that matters: a clave that lasts five
 * minutes, or one bound to the amount, must be fetched at payment time, not
 * when the diner sits down. Optional `idType`/`idNumber` fill the diner's own
 * identity into the SMS bodies that take it.
 *
 * Guest-session gated for consistency with the rest of this surface; the data
 * itself is public and per-bank, never per-diner.
 */
router.get('/c2p/banks', authenticateGuest, perSession, validateQuery(c2pBankGuideQuerySchema), (req, res) => {
  const identity = { idType: req.query.idType, idNumber: req.query.idNumber };
  const data = claveGuide.supportedC2PBanks()
    .map(bank => claveGuide.claveInstructions(bank.code, identity))
    .filter(Boolean);
  res.json({ data });
});

/**
 * Charge the diner's own bank account (Mercantil C2P).
 *
 * Unlike `payment-claims`, this one moves money. The diner supplies a
 * single-use clave they obtained from their own bank and Splite asks Mercantil
 * to pull the amount, so the response is an outcome rather than a message to
 * staff.
 *
 * Four outcomes, and the client must handle all four:
 *
 *   SUCCEEDED  settled; `settlement` carries the new bill figures.
 *   FAILED     the bank said no. Safe to try again with a fresh clave.
 *   IN_DOUBT   the bank did not say. **Do not offer a retry** -- the debit may
 *              have landed. Staff resolve it from the dashboard.
 *   AMBIGUOUS  the debit is confirmed and could not be credited to the bill.
 *              Needs a person, and possibly a refund.
 *
 * `Idempotency-Key` is mandatory, and its stored response is what makes a lost
 * connection safe: a client that never saw the answer replays the original
 * outcome instead of raising a second charge.
 */
router.post(
  '/bill/c2p',
  authenticateGuest,
  perSession,
  // Far tighter than the general guest limit, and not about server load. Each
  // attempt burns a single-use clave the diner had to fetch from their bank,
  // and each one consumes the restaurant's C2P quota with Mercantil. Eight in
  // five minutes is well past honest retrying and well short of useful abuse.
  rateLimit({ windowSeconds: 300, max: 8, keyPrefix: 'guest:c2p' }),
  validateBody(c2pChargeSchema),
  async (req, res, next) => {
    const restaurantId = req.guest.restaurantId;
    const key = req.get('Idempotency-Key') || req.body.idempotencyKey;
    let claimed = false;

    try {
      const idem = await begin({ restaurantId, userId: null, key, hash: requestHash(req) });
      if (!idem.owner) return res.status(idem.response.status).json(idem.response.body);
      claimed = true;

      const bill = await openBillForGuest(req.guest);
      const result = await mercantilC2P.createC2PPayment({
        restaurantId,
        billId: bill.id,
        amountVes: req.body.amountVes,
        payer: {
          bankCode: req.body.bankCode,
          idNumber: req.body.idNumber,
          phone: req.body.phone,
          clave: req.body.clave
        },
        idempotencyKey: key,
        splitParticipantId: req.body.splitParticipantId ?? null,
        tipVes: req.body.tipVes ?? '0'
      });

      // Stored before replying, so a retry that races the response replays the
      // outcome rather than charging again. This is the line that makes an
      // IN_DOUBT charge safe to sit on: the retry cannot reach the bank.
      await complete({ restaurantId, key, status: 201, body: result });

      await logAudit({
        ...auditContext(req),
        restaurantId,
        action: 'C2P_CHARGE_RAISED',
        resourceType: 'payment',
        resourceId: result.paymentId,
        details: { billId: bill.id, status: result.status }
      });

      res.status(201).json(result);
    } catch (err) {
      // Only reached before the bank was asked, or when the charge was
      // rejected outright -- createC2PPayment converts every post-debit failure
      // into a returned outcome precisely so this branch cannot release a key
      // that a real debit is sitting behind.
      if (claimed) {
        try { await abort({ restaurantId, key }); } catch (abortErr) {
          logger.error({ event: 'IDEMPOTENCY_ABORT_FAILED', err: abortErr }, 'Idempotency abort failed');
        }
      }
      next(err);
    }
  }
);

/**
 * Agrees a persistent split of the guest's own bill.
 *
 * The diners at a table settle on who pays what and store it, so each can then
 * pay their own share -- by Pago Movil claim or C2P -- and no one can pay more
 * than their share. Takes no bill id, like every guest route: the table comes
 * from the session.
 */
router.post('/bill/splits', authenticateGuest, perSession, validateBody(splitPreviewSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const items = req.body.mode === 'ITEMS'
      ? await billItems.listForBill({ restaurantId: req.guest.restaurantId, billId: bill.id })
      : [];
    const split = await splits.createSplit({
      restaurantId: req.guest.restaurantId,
      bill, items, request: req.body,
      createdBy: { type: 'GUEST', id: null }
    });
    res.status(201).json(dto.billSplit(split));
  } catch (err) { next(err); }
});

/** The live split on the guest's bill, or 404. */
router.get('/bill/splits/active', authenticateGuest, perSession, async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const split = await splits.getActiveSplit({ restaurantId: req.guest.restaurantId, billId: bill.id, bill });
    if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'This bill has no active split');
    res.json(dto.billSplit(split));
  } catch (err) { next(err); }
});

/**
 * A split of the guest's own bill.
 *
 * The same engine the staff endpoint uses, so a diner and a waiter looking at
 * the same bill are never shown two different allocations. Advisory: it
 * computes and returns, and moves no money.
 */
router.post('/bill/split/preview', authenticateGuest, perSession, validateBody(splitPreviewSchema), async (req, res, next) => {
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
router.delete('/sessions', authenticateGuest, perSession, async (req, res, next) => {
  try {
    await destroyGuestSession(req.guest.sessionId);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
