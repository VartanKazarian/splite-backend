const crypto = require('crypto');
const config = require('../config');
const { redis } = require('../connectors/redis');
const { safeEqual } = require('../utils/tokens');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');

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
      return next(new ApiError('WEBHOOK_SIGNATURE_MISSING', 'Webhook signature or timestamp missing'));
    }
    if (typeof req.rawBody !== 'string') {
      return next(new ApiError('WEBHOOK_BODY_UNVERIFIABLE', 'Webhook body could not be verified'));
    }

    const requestTime = Number(timestamp);
    const now = Math.floor(Date.now() / 1000);
    // Absolute difference: a far-future timestamp is as invalid as a stale one.
    if (!Number.isInteger(requestTime) || Math.abs(now - requestTime) > config.webhookToleranceSeconds) {
      return next(new ApiError('WEBHOOK_TIMESTAMP_OUT_OF_TOLERANCE', 'Webhook timestamp outside tolerance window'));
    }

    const expected = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(`${timestamp}.${req.rawBody}`, 'utf8')
      .digest('hex');

    if (!safeEqual(expected, signature)) {
      return next(new ApiError('WEBHOOK_SIGNATURE_INVALID', 'Invalid webhook signature'));
    }

    if (replayProtection) {
      try {
        const key = `webhook:seen:${expected}`;
        const stored = await redis.set(key, '1', 'EX', config.webhookToleranceSeconds * 2, 'NX');
        if (stored === null) return next(new ApiError('WEBHOOK_ALREADY_PROCESSED', 'Webhook already processed'));
      } catch (err) {
        // Fail closed: without the replay store we cannot guarantee
        // exactly-once handling of a money-moving callback.
        logger.error({ event: 'WEBHOOK_REPLAY_STORE_UNAVAILABLE', err }, 'Webhook replay store unavailable');
        return next(new ApiError('WEBHOOK_REPLAY_PROTECTION_UNAVAILABLE', 'Webhook replay protection unavailable'));
      }
    }

    next();
  };
}

module.exports = verifyWebhookSignature;
