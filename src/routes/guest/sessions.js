/** A diner's session: opened by scanning the QR, closed on the way out. */
const express = require('express');
const { validateBody, guestSessionSchema } = require('../../middleware/schemas');
const {
  createGuestSession,
  destroyGuestSession,
  authenticateGuest
} = require('../../services/guest');
const rateLimit = require('../../middleware/rateLimit');
const { logAudit } = require('../../services/audit');
const { perSession, tableForQr } = require('./shared');

const router = express.Router();

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
