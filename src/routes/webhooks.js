const express = require('express');
const rateLimit = require('../middleware/rateLimit');
const { handleDelivery } = require('../services/webhooks');
const { validateParams, webhookProviderParamSchema } = require('../middleware/schemas');

/**
 * Inbound provider webhooks.
 *
 * Its own router, mounted at its own path and nowhere else. Mounting the
 * payments router under a second prefix to "also" serve webhooks makes every
 * payment route reachable at that prefix too, and any middleware attached by
 * prefix -- authentication, rate limiting -- is then skipped by changing the
 * URL. That is an authorisation bypass wearing the costume of a convenience.
 *
 * Deliberately unauthenticated in the staff sense: a provider has no session.
 * The HMAC signature is the credential, and it is verified before anything is
 * read, recorded or acted on.
 */
const router = express.Router();

/**
 * How long to ask a provider to wait before resending an unresolved delivery.
 *
 * Sized for the race it exists to cover: a callback that overtook the commit of
 * our own PENDING payment row. That gap is milliseconds, so this only has to be
 * longer than one transaction, not longer than a human noticing.
 */
const RETRY_AFTER_SECONDS = 30;

// Keyed per source address, generous enough for retry storms and small enough
// to bound a flood of forged deliveries. Fails open: a Redis outage must not
// stop a real provider from telling us a diner paid, and the signature -- not
// this -- is what keeps forgeries out.
router.use(rateLimit({ windowSeconds: 60, max: 240, keyPrefix: 'webhook' }));

router.post('/:provider', validateParams(webhookProviderParamSchema), async (req, res, next) => {
  try {
    const result = await handleDelivery(req, res, req.params.provider.toUpperCase());

    // 202 means "we are done with this delivery, stop sending it" -- settled,
    // a duplicate of something settled, or a body that never named a payment
    // and never will however many times it is resent.
    //
    // It deliberately does NOT cover a delivery we merely failed to process.
    // That distinction used to be missing: an unresolved payment answered 202,
    // so a callback arriving in the moment before our own PENDING row committed
    // was accepted, never retried, and the bill stayed open against money that
    // had already moved. Those now throw, and reach the provider as 5xx.
    res.status(202).json(result);
  } catch (err) {
    // Providers key their backoff off this header where it is present.
    if (err.code === 'WEBHOOK_PAYMENT_UNRESOLVED') {
      res.set('Retry-After', String(RETRY_AFTER_SECONDS));
      err.details = { ...err.details, retryAfterSeconds: RETRY_AFTER_SECONDS };
    }
    next(err);
  }
});

module.exports = router;
