const express = require('express');
const { authenticateToken } = require('../middleware/auth');
const { validateParams, guestOrderIdParamSchema } = require('../middleware/schemas');
const rateLimit = require('../middleware/rateLimit');
const guestOrders = require('../services/guestOrders');
const { logAudit, auditContext } = require('../services/audit');
const dto = require('../dto');

const router = express.Router();

// A nivel de router, para que no se pueda añadir una ruta sin ello.
router.use(authenticateToken);
router.use(rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'orders' }));

/**
 * Los pedidos que la sala no ha mirado todavía.
 *
 * Sin filtros ni paginación por ahora: esto es la bandeja de un turno, no un
 * histórico. Si un restaurante llega a tener cincuenta pedidos sin ver a la
 * vez, el problema no es la paginación.
 *
 * Cualquier rol del restaurante puede leerla -- un mesero es exactamente quien
 * tiene que verla -- y está acotada al restaurante del token, como todo lo
 * demás de esta superficie.
 */
router.get('/', async (req, res, next) => {
  try {
    const rows = await guestOrders.listPending({ restaurantId: req.user.restaurantId });
    res.json({ data: rows.map(dto.guestOrder) });
  } catch (err) { next(err); }
});

/**
 * El recuento, para el panel.
 *
 * La lista entera trae las líneas de cada pedido; esto es una cifra y la
 * antigüedad del más viejo. El panel lo pide cada pocos segundos y no debería
 * traerse una comanda completa para pintar un número -- el mismo motivo por el
 * que existe `/payments/claims/summary`.
 */
router.get('/summary', async (req, res, next) => {
  try {
    res.json(await guestOrders.pendingSummary({ restaurantId: req.user.restaurantId }));
  } catch (err) { next(err); }
});

/**
 * Dar un pedido por visto.
 *
 * No cambia nada de la cuenta: las líneas ya estaban dentro desde que el
 * comensal pulsó enviar. Lo único que hace es sacar el aviso de la bandeja, y
 * dejar escrito quién se hizo cargo.
 *
 * Idempotente a propósito: dos meseros tocando el mismo aviso a la vez es lo
 * normal en una sala, y el segundo no debería llevarse un error por llegar
 * tarde. Se responde 200 con el estado final en los dos casos.
 */
router.post('/:id/ack', validateParams(guestOrderIdParamSchema), async (req, res, next) => {
  try {
    const result = await guestOrders.acknowledge({
      restaurantId: req.user.restaurantId,
      orderId: req.params.id,
      userId: req.user.sub
    });

    // Sólo se audita el que de verdad cambió algo. Auditar el segundo toque
    // llenaría el registro de líneas que no describen ningún cambio.
    if (result.changed) {
      await logAudit({
        ...auditContext(req),
        action: 'GUEST_ORDER_ACKNOWLEDGED',
        resourceType: 'guest_order',
        resourceId: result.id
      });
    }

    res.json({ id: result.id, acknowledgedAt: result.acknowledgedAt });
  } catch (err) { next(err); }
});

module.exports = router;
