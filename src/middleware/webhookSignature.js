const crypto = require('crypto');
const config = require('../config');

function verifyWebhookSignature(req, res, next) {
    const signatureHeader = req.headers['x-webhook-signature'];
    const timestampHeader = req.headers['x-webhook-timestamp'];

    const requestTime = parseInt(timestampHeader, 10);
    const currentTime = Math.floor(Date.now() / 1000);
    if (!requestTime || (currentTime - requestTime) > 300) {
        return res.status(401).json({ error: 'Webhook timestamp expired or missing' });
    }

    const payload = `${timestampHeader}.${req.rawBody}`;
    const expectedSignature = crypto
        .createHmac('sha256', config.webhookSecret)
        .update(payload, 'utf-8')
        .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const receivedBuffer = Buffer.from(signatureHeader || '');

    if (
        expectedBuffer.length !== receivedBuffer.length || 
        !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    next();
}

module.exports = verifyWebhookSignature;
