const express = require('express');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { validateParams, validateBody, guestOrderIdParamSchema, orderSettingsSchema } = require('../middleware/schemas');
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
 * Si el primer pedido de cada teléfono nuevo espera a la sala.
 *
 * Cualquiera del personal puede leerlo (la bandeja cambia según esté o no);
 * sólo dueño y encargado lo cambian.
 */
router.get('/settings', async (req, res, next) => {
  try {
    res.json(await guestOrders.getSettings({ restaurantId: req.user.restaurantId }));
  } catch (err) { next(err); }
});

router.patch('/settings', requireRole('OWNER', 'MANAGER'), validateBody(orderSettingsSchema), async (req, res, next) => {
  try {
    const result = await guestOrders.updateSettings({
      restaurantId: req.user.restaurantId,
      approveNewPhones: req.body.approveNewPhones
    });
    await logAudit({
      ...auditContext(req),
      action: 'ORDER_APPROVAL_SETTING_CHANGED',
      resourceType: 'restaurant',
      resourceId: req.user.restaurantId,
      details: { approveNewPhones: result.approveNewPhones }
    });
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * Aprobar el primer pedido de un teléfono nuevo: entra en la cuenta (abriéndola
 * si la mesa está libre) y ese teléfono ya pide sin esperar.
 *
 * Cualquier rol: quien está en la sala es quien ve si en esa mesa hay alguien.
 */
router.post('/:id/approve', validateParams(guestOrderIdParamSchema), async (req, res, next) => {
  try {
    const result = await guestOrders.approve({
      restaurantId: req.user.restaurantId,
      orderId: req.params.id,
      userId: req.user.sub
    });
    await logAudit({
      ...auditContext(req),
      action: result.opened ? 'BILL_OPENED_BY_APPROVED_GUEST_ORDER' : 'GUEST_ORDER_APPROVED',
      resourceType: 'guest_order',
      resourceId: result.orderId
    });
    res.json({ id: result.orderId, status: result.status, billId: result.bill?.id ?? null });
  } catch (err) { next(err); }
});

/**
 * Rechazarlo: no llega a ninguna cuenta, y ese teléfono no vuelve a pedir sin
 * escanear otra vez. Idempotente.
 */
router.post('/:id/reject', validateParams(guestOrderIdParamSchema), async (req, res, next) => {
  try {
    const result = await guestOrders.reject({
      restaurantId: req.user.restaurantId,
      orderId: req.params.id,
      userId: req.user.sub
    });
    if (result.changed) {
      await logAudit({
        ...auditContext(req),
        action: 'GUEST_ORDER_REJECTED',
        resourceType: 'guest_order',
        resourceId: result.id
      });
    }
    res.json({ id: result.id, status: result.status, decidedAt: result.decidedAt });
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
