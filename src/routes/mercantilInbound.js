const express = require('express');

const config = require('../config');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');
const connections = require('../services/bankConnections');

/**
 * Las notificaciones de pago de Mercantil, de todos los restaurantes, en una
 * sola URL: `POST /api/v1/bank-inbound/mercantil`. Ver
 * `services/bankConnections.js#mercantilInbound` y docs/bank-connections.md.
 *
 * Sin sesión y sin firma: lo que autentica un mensaje es que la llave del
 * comercio cuyo RIF trae la cabecera `CompIdentif` lo abra. Si hay IPs del
 * banco configuradas, además, sólo desde ellas.
 *
 * Lo que se rechaza es un 401 con el error de siempre de la API: para el banco
 * cualquier estado que no sea 200 es un fallo, y lo reintenta. El sobre del
 * banco va sólo con los 200.
 *
 * Su propio router, montado antes que el de `/:connectionId`, y con su propio
 * limitador: todo llega desde las mismas pocas IPs del banco.
 */
const router = express.Router();

// El documento del banco no dice el Content-Type. JSON lo lee ya `app.js`; si
// llega como texto, se lee aquí.
router.use(express.text({ type: ['text/*'], limit: '64kb' }));

function bareIp(ip) {
  return String(ip ?? '').replace(/^::ffff:/, '');
}

router.post('/', async (req, res, next) => {
  try {
    const allowed = config.payments.mercantil.notifyAllowedIps;
    if (allowed.length && !allowed.includes(bareIp(req.ip))) {
      logger.warn({ event: 'MERCANTIL_NOTIFY_IP_REFUSED', ip: bareIp(req.ip) }, 'Mercantil notification from an unlisted IP');
      throw new ApiError('BANK_INBOUND_UNAUTHORIZED', 'Invalid notification');
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }

    const result = await connections.mercantilInbound({ rif: req.get('compidentif'), body });
    logger.info({
      event: 'MERCANTIL_NOTIFICATION',
      connectionId: result.connection ? result.connection.id : null,
      outcome: result.outcome,
      status: result.status
    }, 'Mercantil payment notification');
    if (result.status !== 200) throw new ApiError('BANK_INBOUND_UNAUTHORIZED', 'Invalid notification');
    res.set('Cache-Control', 'no-store');
    return res.json(result.envelope);
  } catch (err) { return next(err); }
});

module.exports = router;
