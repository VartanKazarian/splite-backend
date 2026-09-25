const express = require('express');

const dto = require('../dto');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody, validateParams, createBankConnectionSchema, updateBankConnectionSchema,
  bankConnectionIdParamSchema, bankMovementsSchema
} = require('../middleware/schemas');
const { auditContext } = require('../services/audit');
const connections = require('../services/bankConnections');

/**
 * Las conexiones del restaurante con su banco. Ver `services/bankConnections.js`.
 *
 * Quién puede qué:
 *   - Crear, cambiar, dar de baja, rotar la firma y encender la confirmación
 *     automática: sólo el dueño. Es decidir en qué fuente confía el local para
 *     dar por cobrado un dinero.
 *   - Ver las conexiones y subir un estado de cuenta: también encargado y
 *     caja, que son quienes verifican los cobros a diario.
 */
const router = express.Router();
router.use(authenticateToken);

const owner = requireRole('OWNER');
const verifiers = requireRole('OWNER', 'MANAGER', 'CASHIER');

router.get('/', verifiers, async (req, res, next) => {
  try {
    const rows = await connections.listConnections({ restaurantId: req.user.restaurantId });
    res.json({ data: rows.map(dto.bankConnection) });
  } catch (err) { next(err); }
});

router.post('/', owner, validateBody(createBankConnectionSchema), async (req, res, next) => {
  try {
    const { connection, secret, path } = await connections.createConnection({
      restaurantId: req.user.restaurantId,
      actor: { id: req.user.sub, role: req.user.role },
      kind: req.body.kind,
      label: req.body.label,
      bankCode: req.body.bankCode ?? null,
      meta: auditContext(req)
    });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ connection: dto.bankConnection(connection), ...(secret ? { secret, path } : {}) });
  } catch (err) { next(err); }
});

router.patch(
  '/:connectionId', owner, validateParams(bankConnectionIdParamSchema), validateBody(updateBankConnectionSchema),
  async (req, res, next) => {
    try {
      const updated = await connections.updateConnection({
        restaurantId: req.user.restaurantId,
        actor: { id: req.user.sub, role: req.user.role },
        connectionId: req.params.connectionId,
        changes: req.body,
        meta: auditContext(req)
      });
      res.json({ connection: dto.bankConnection(updated) });
    } catch (err) { next(err); }
  }
);

router.post(
  '/:connectionId/rotate-secret', owner, validateParams(bankConnectionIdParamSchema),
  async (req, res, next) => {
    try {
      const { connection, secret, path } = await connections.rotateSecret({
        restaurantId: req.user.restaurantId,
        actor: { id: req.user.sub, role: req.user.role },
        connectionId: req.params.connectionId,
        meta: auditContext(req)
      });
      res.set('Cache-Control', 'no-store');
      res.json({ connection: dto.bankConnection(connection), secret, path });
    } catch (err) { next(err); }
  }
);

/**
 * Un estado de cuenta, ya partido en columnas por el navegador y mandado en
 * tandas de hasta 500 filas. Cada fila la valida el normalizador.
 */
router.post(
  '/:connectionId/import', verifiers, validateParams(bankConnectionIdParamSchema), validateBody(bankMovementsSchema),
  async (req, res, next) => {
    try {
      const connection = await connections.getConnection({
        restaurantId: req.user.restaurantId, connectionId: req.params.connectionId
      });
      if (connection.kind !== 'STATEMENT_IMPORT') {
        const { ApiError } = require('../errors');
        throw new ApiError('BANK_CONNECTION_KIND_MISMATCH', 'Only a statement-import connection accepts uploads');
      }
      res.json(await connections.ingest({ connection, rows: req.body.movements }));
    } catch (err) { next(err); }
  }
);

router.get(
  '/:connectionId/movements', verifiers, validateParams(bankConnectionIdParamSchema),
  async (req, res, next) => {
    try {
      const rows = await connections.recentMovements({
        restaurantId: req.user.restaurantId, connectionId: req.params.connectionId
      });
      res.json({ data: rows.map(dto.bankMovement) });
    } catch (err) { next(err); }
  }
);

module.exports = router;
