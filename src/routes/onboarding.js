const express = require('express');
const crypto = require('crypto');
const onboarding = require('../services/onboarding');
const rateLimit = require('../middleware/rateLimit');
const config = require('../config');
const {
  validateBody, onboardingSignupSchema, onboardingVerifySchema
} = require('../middleware/schemas');

const router = express.Router();

/**
 * Public restaurant registration.
 *
 * The only unauthenticated write surface in the API besides the guest session
 * exchange, and unlike that one it is not gated by a signed QR -- anyone on the
 * internet can reach it. Everything below follows from that.
 *
 * Note what is *not* here: there is no route that invites a lead. That step is
 * taken by the Splite team after they have telephoned the restaurant, and every
 * authenticated surface in this API is scoped to a tenant the caller belongs to
 * -- there is no platform-operator role to authorise it. It lives in
 * `npm run onboarding` instead. See src/services/onboarding.js.
 */

const requestMeta = req => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
  requestId: req.id ?? null
});

/**
 * Two limiters, because they stop different attacks.
 *
 * Per source address bounds how fast one machine can register restaurants.
 * It does nothing about the other abuse this endpoint enables: it sends mail to
 * an address chosen by the caller, so a distributed caller can flood one
 * person's inbox while every individual IP stays well inside its budget. The
 * second limiter counts per recipient and is what actually prevents that.
 *
 * failClosed on both. A Redis outage that quietly removed the limit from a
 * public endpoint that sends email is worse than the endpoint being unavailable.
 */
const perAddress = rateLimit({
  windowSeconds: 3600, max: 5, keyPrefix: 'onboard:ip', failClosed: true
});

const perEmail = rateLimit({
  windowSeconds: 3600,
  max: 3,
  keyPrefix: 'onboard:email',
  failClosed: true,
  // Null until the body has an email, which skips the check and lets the schema
  // reject the request with VALIDATION_FAILED rather than RATE_LIMITED. Hashed
  // so a Redis key never holds a customer's address in clear text.
  identify: req => {
    const email = req.body?.email;
    if (typeof email !== 'string' || !email.includes('@')) return null;
    // Trimmed and lowercased to match what the schema will normalise it to, so
    // " Owner@X.com " and "owner@x.com" land in the same bucket rather than
    // buying a second allowance.
    return crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  }
});

router.post(
  '/restaurants',
  perAddress,
  perEmail,
  validateBody(onboardingSignupSchema),
  async (req, res, next) => {
    try {
      const result = await onboarding.submitLead(req.body, requestMeta(req));
      // 202, not 201: no tenant was created and none will be until somebody at
      // Splite has read this and telephoned them. The body says the same thing
      // to every caller.
      res.status(202).json(result);
    } catch (err) { next(err); }
  }
);

/**
 * Consumes the emailed link, creates the tenant and signs the owner in.
 *
 * Rate limited harder than the signup itself: the token is 32 random bytes, so
 * guessing is not the threat -- but this is the endpoint that runs Argon2id,
 * and 19 MiB of hashing per unauthenticated request is worth bounding.
 */
router.post(
  '/verify',
  rateLimit({
    windowSeconds: 3600,
    max: 10,
    keyPrefix: 'onboard:verify',
    failClosed: config.rateLimit.failClosedOnAuth
  }),
  validateBody(onboardingVerifySchema),
  async (req, res, next) => {
    try {
      const { restaurant, session } = await onboarding.verifySignup(
        req.body.token, req.body.password, requestMeta(req)
      );

      res.status(201).json({
        restaurant: {
          id: restaurant.id,
          name: restaurant.name,
          rif: restaurant.rif,
          menuCurrency: restaurant.menu_currency,
          vatBps: restaurant.vat_bps,
          serviceChargeBps: restaurant.service_charge_bps
        },
        ...session
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
