const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { validateBody, pushSubscriptionSchema, pushUnsubscribeSchema } = require('../middleware/schemas');
const rateLimit = require('../middleware/rateLimit');
const push = require('../services/push');

/**
 * Avisos en el teléfono del personal (R19). Cualquier rol: cada uno recibe lo
 * suyo (`push.AUDIENCE`), y apagarlos en su teléfono es cosa de cada uno.
 */
const router = express.Router();

router.use(authenticateToken);
router.use(rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'push' }));

/** Si están encendidos en este despliegue, y la clave con la que suscribirse. */
router.get('/config', async (req, res, next) => {
  try {
    res.json(await push.publicConfig());
  } catch (err) { next(err); }
});

/** Este teléfono, para quien ha entrado en él. */
router.post('/subscriptions', validateBody(pushSubscriptionSchema), async (req, res, next) => {
  try {
    await push.subscribe({
      restaurantId: req.user.restaurantId,
      userId: req.user.sub,
      endpoint: req.body.endpoint,
      p256dh: req.body.keys.p256dh,
      auth: req.body.keys.auth,
      userAgent: req.get('user-agent')
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Apagarlos en este teléfono. Sin error si ya no estaba. */
router.delete('/subscriptions', validateBody(pushUnsubscribeSchema), async (req, res, next) => {
  try {
    await push.unsubscribe({ userId: req.user.sub, endpoint: req.body.endpoint });
    res.status(204).end();
  } catch (err) { next(err); }
});

/** Un aviso de prueba a los teléfonos de quien lo pide. */
router.post('/test', rateLimit({ windowSeconds: 60, max: 3, keyPrefix: 'push-test' }), async (req, res, next) => {
  try {
    res.json(await push.sendTest({ restaurantId: req.user.restaurantId, userId: req.user.sub }));
  } catch (err) { next(err); }
});

module.exports = router;
