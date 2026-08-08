const crypto = require('crypto');
const config = require('../config');
const { redis } = require('../connectors/redis');
const { safeEqual } = require('../utils/tokens');

/**
 * Verifies HMAC-signed provider webhooks.
 *
 * Three properties matter here:
 *  1. Signature covers timestamp + raw body (not the parsed body).
 *  2. Timestamps outside the tolerance window are rejected.
 *  3. A signature may only be used once (replay protection via Redis).
 */
function verifyWebhookSignature({ replayProtection = true } = {}) {
  return async (req, res, next) => {
    const signature = req.get('x-webhook-signature');
    const timestamp = req.get('x-webhook-timestamp');

    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Webhook signature or timestamp missing' });
    }
    if (typeof req.rawBody !== 'string') {
      return res.status(400).json({ error: 'Webhook body could not be verified' });
    }

    const requestTime = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);
    // Absolute difference: a far-future timestamp is as invalid as a stale one.
    if (!Number.isInteger(requestTime) || Math.abs(now - requestTime) > config.webhookToleranceSeconds) {
      return res.status(401).json({ error: 'Webhook timestamp outside tolerance window' });
    }

    const expected = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(`${timestamp}.${req.rawBody}`, 'utf8')
      .digest('hex');

    if (!safeEqual(expected, signature)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    if (replayProtection) {
      try {
        const key = `webhook:seen:${expected}`;
        const stored = await redis.set(key, '1', 'EX', config.webhookToleranceSeconds * 2, 'NX');
        if (stored === null) return res.status(409).json({ error: 'Webhook already processed' });
      } catch (err) {
        // Fail closed: without the replay store we cannot guarantee
        // exactly-once handling of a money-moving callback.
        console.error('[WebhookReplay]', err.message);
        return res.status(503).json({ error: 'Webhook replay protection unavailable' });
      }
    }

    next();
  };
}

module.exports = verifyWebhookSignature;
