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

// Keyed per source address, generous enough for retry storms and small enough
// to bound a flood of forged deliveries. Fails open: a Redis outage must not
// stop a real provider from telling us a diner paid, and the signature -- not
// this -- is what keeps forgeries out.
router.use(rateLimit({ windowSeconds: 60, max: 240, keyPrefix: 'webhook' }));

router.post('/:provider', validateParams(webhookProviderParamSchema), async (req, res, next) => {
  try {
    const result = await handleDelivery(req, res, req.params.provider.toUpperCase());

    // 202, always, once the signature is good. The provider is being told the
    // delivery was accepted, which is a different question from whether it
    // settled anything -- an unattributable body is our problem to work out,
    // and having the provider retry it forever would not help.
    res.status(202).json(result);
  } catch (err) { next(err); }
});

module.exports = router;
