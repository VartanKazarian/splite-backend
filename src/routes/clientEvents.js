const express = require('express');
const Joi = require('joi');

const rateLimit = require('../middleware/rateLimit');
const { ApiError } = require('../errors');
const clientEvents = require('../services/clientEvents');

/**
 * Donde el navegador cuenta lo que le pasó (FR4): errores y velocidad.
 *
 * Sin sesión -- un comensal sin cuenta también falla -- y por eso con un
 * límite por IP y un cuerpo pequeño. Llega como `text/plain` con JSON dentro a
 * propósito: así es una petición «simple» de CORS, sin pregunta previa, que es
 * lo único que un `fetch(…, { keepalive: true })` al cerrar la página puede
 * mandar sin perderse.
 */
const router = express.Router();

const eventSchema = Joi.object({
  kind: Joi.string().valid('error', 'vital').required(),
  path: Joi.string().max(500),
  surface: Joi.string().valid('guest', 'staff', 'public', 'admin').default('public'),
  release: Joi.string().max(60),
  // error
  message: Joi.when('kind', { is: 'error', then: Joi.string().max(2000).required(), otherwise: Joi.forbidden() }),
  stack: Joi.when('kind', { is: 'error', then: Joi.string().max(8000), otherwise: Joi.forbidden() }),
  // vital
  name: Joi.when('kind', {
    is: 'vital', then: Joi.string().valid('LCP', 'INP', 'CLS', 'FCP', 'TTFB').required(), otherwise: Joi.forbidden()
  }),
  value: Joi.when('kind', { is: 'vital', then: Joi.number().min(0).max(600000).required(), otherwise: Joi.forbidden() }),
  rating: Joi.when('kind', {
    is: 'vital', then: Joi.string().valid('good', 'needs-improvement', 'poor'), otherwise: Joi.forbidden()
  }),
  connection: Joi.string().max(20)
});

router.post(
  '/',
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'client-events' }),
  express.text({ type: ['text/plain', 'application/json'], limit: '12kb' }),
  async (req, res, next) => {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = null; }
      }
      const { value, error } = eventSchema.validate(body ?? {}, { stripUnknown: true });
      if (error) throw new ApiError('VALIDATION_FAILED', 'Invalid client event', { fields: error.details.map(d => d.path.join('.')) });

      if (value.kind === 'error') {
        await clientEvents.recordError({ ...value, userAgent: req.get('user-agent') });
      } else {
        clientEvents.recordVital(value);
      }
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
