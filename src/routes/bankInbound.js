const express = require('express');

const { validateParams, validateBody, bankConnectionIdParamSchema, bankMovementsSchema } = require('../middleware/schemas');
const connections = require('../services/bankConnections');

/**
 * La entrada de movimientos por webhook, para cualquier sistema que sepa hacer
 * un POST firmado. Ver docs/bank-connections.md.
 *
 * Sin sesión: la firma es la credencial, y se comprueba sobre los bytes
 * exactos del cuerpo (`req.rawBody`) antes de leer nada. La hora va dentro de
 * lo firmado y fuera de cinco minutos se rechaza; repetir una petición dentro
 * de la ventana no hace nada, porque los movimientos son idempotentes.
 *
 * Su propio router y su propia ruta, como los webhooks de proveedores: montar
 * otro router aquí haría que sus rutas respondieran sin su autenticación.
 */
const router = express.Router();

router.post(
  '/:connectionId',
  validateParams(bankConnectionIdParamSchema),
  async (req, res, next) => {
    try {
      const connection = await connections.authenticateInbound({
        connectionId: req.params.connectionId,
        timestamp: req.get('x-splite-timestamp'),
        signature: req.get('x-splite-signature'),
        rawBody: typeof req.rawBody === 'string' ? req.rawBody : ''
      });
      res.locals.bankConnection = connection;
      next();
    } catch (err) { next(err); }
  },
  validateBody(bankMovementsSchema),
  async (req, res, next) => {
    try {
      res.json(await connections.ingest({ connection: res.locals.bankConnection, rows: req.body.movements }));
    } catch (err) { next(err); }
  }
);

module.exports = router;
