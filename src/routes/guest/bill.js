/** The bill as the diner sees it, and the orders they place from the menu. */
const express = require('express');
const db = require('../../connectors/base');
const {
  validateBody,
  validateParams,
  guestOrderSchema,
  guestOrderIdParamSchema
} = require('../../middleware/schemas');
const { authenticateGuest } = require('../../services/guest');
const rateLimit = require('../../middleware/rateLimit');
const billItems = require('../../services/billItems');
const inFlight = require('../../services/inFlight');
const paymentHolds = require('../../services/paymentHolds');
const guestOrders = require('../../services/guestOrders');
const mercantilC2P = require('../../services/mercantilC2P');
const dto = require('../../dto');
const { logAudit } = require('../../services/audit');
const invoicing = require('../../services/fiscalInvoicing');
const { perSession, openBillForGuest } = require('./shared');
const { requestHash, begin, complete, abort } = require('../../services/idempotency');
const { ApiError } = require('../../errors');
const { logger } = require('../../connectors/logger');

/**
 * La clave de idempotencia de un pedido, si el teléfono mandó una.
 *
 * Opcional para que un cliente anterior siga pidiendo. Con ella, un pedido
 * reintentado tras un corte -- el comensal no sabe si llegó y pulsa otra vez --
 * devuelve la respuesta del primero en vez de pedirlo dos veces a cocina.
 *
 * Va con la sesión delante: las claves son de todo el restaurante
 * (`idempotency_keys` es única por restaurante y clave), y la de un teléfono no
 * debe poder devolverle a otro la respuesta de su pedido. 80 caracteres como
 * mucho para que el total quepa en la columna (128).
 */
function orderIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined) return null;
  const key = raw.trim();
  if (!/^[A-Za-z0-9._:-]{16,80}$/.test(key)) {
    throw new ApiError('VALIDATION_FAILED', 'Idempotency-Key must be 16-80 characters of [A-Za-z0-9._:-]');
  }
  return `go:${req.guest.sessionId ?? req.guest.tableId}:${key}`;
}

const router = express.Router();

/**
 * La cuenta de un pago que hizo este comensal, esté abierta o cerrada.
 *
 * `openBillForGuest` exige `status = 'OPEN'`, que es correcto para todo lo que
 * ocurre **durante** la cena: dividir, pedir, pagar. Para la factura es justo
 * lo contrario, y ahí estaba el fallo: confirmar el pago cierra la cuenta, así
 * que anclar la factura a la cuenta abierta la hacía imposible de pedir
 * exactamente en el instante en que pasaba a poder pedirse.
 *
 * Una factura es de **un pago**, no de una cuenta abierta. Así que se resuelve
 * desde el pago hacia arriba.
 *
 * El aislamiento no se relaja por eso: el pago tiene que estar en una cuenta de
 * **la mesa de esta sesión** y del restaurante de esta sesión. El comensal
 * además tiene que conocer el UUID, que sólo recibe quien declaró ese pago.
 */
async function invoiceOfferedAt(restaurantId) {
  const { rows } = await db.query(
    `SELECT r.plan_tier,
            EXISTS (SELECT 1 FROM fiscal_series fs WHERE fs.restaurant_id = r.id) AS has_series,
            (NULLIF(TRIM(r.rif), '') IS NOT NULL) AS has_rif
       FROM restaurants r WHERE r.id = $1`,
    [restaurantId]
  );
  if (!rows.length) return false;
  return invoicing.canIssue({
    planTier: rows[0].plan_tier, hasSeries: rows[0].has_series, hasRif: rows[0].has_rif
  });
}

/**
 * Who the diner is actually paying.
 *
 * Splite never holds the money -- a Pago Móvil goes from the diner's account to
 * the restaurant's -- so without this the bill screen can show what is owed and
 * offer no way to pay it. Bank, phone and identity document, which is what
 * addressing a Pago Móvil takes; the account number stays behind the staff
 * surface.
 */
/**
 * Quién recibe el dinero.
 *
 * Splite nunca lo retiene -- un Pago Móvil va de la cuenta del comensal a la
 * del restaurante --, así que sin esto la pantalla puede decir lo que se debe y
 * no ofrecer forma de pagarlo. Banco, teléfono y documento, que es lo que hace
 * falta para dirigir un Pago Móvil; el número de cuenta se queda del lado del
 * personal.
 */
async function payeeForGuest(guest) {
  const { rows } = await db.query(
    `SELECT payout_bank_code, payout_phone, payout_holder_id
       FROM restaurants WHERE id = $1`,
    [guest.restaurantId]
  );
  return rows[0] ? dto.guestPayee(rows[0]) : null;
}

router.get('/bill', authenticateGuest, perSession, async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    // `c2pAvailable` viaja con la cuenta porque decide qué formas de pago se
    // dibujan, y hasta ahora no viajaba nada: la pantalla ofrecía C2P siempre,
    // incluso donde el raíl no está configurado, y el comensal lo descubría
    // después de ir a su banco a por una clave de un solo uso.
    //
    // `canRequestInvoice`, por lo mismo y un paso antes: el aviso de pago
    // ofrece «envíame la factura» y sólo debe ofrecerlo donde se puede cumplir.
    // Es el mismo cálculo que el estado del pago, que sigue haciendo falta
    // allí porque la cuenta deja de leerse en cuanto se cierra.
    const [items, payee, c2pAvailable, canRequestInvoice, pending, holds] = await Promise.all([
      billItems.listForBill({ restaurantId: req.guest.restaurantId, billId: bill.id }),
      payeeForGuest(req.guest),
      mercantilC2P.c2pAvailable(req.guest.restaurantId),
      invoiceOfferedAt(req.guest.restaurantId),
      inFlight.forBill({ restaurantId: req.guest.restaurantId, billId: bill.id }),
      paymentHolds.liveForBill({
        restaurantId: req.guest.restaurantId, billId: bill.id, viewerSessionId: req.guest.sessionId
      })
    ]);
    res.json({
      ...dto.guestBill(bill, items, {
        pendingVes: pending.totalVes, pendingCount: pending.count,
        heldVes: holds.othersVes, heldUntil: holds.othersUntil, myHold: holds.mine
      }),
      payee, c2pAvailable, canRequestInvoice
    });
  } catch (err) { next(err); }
});

/**
 * "I paid by Pago Móvil, here is my reference."
 *
 * Creates a claim and settles nothing. The money moved between the diner's bank
 * and the restaurant's without passing through Splite, so no API of ours can
 * see it arrive -- the only honest thing this endpoint can do is carry the
 * diner's word to a person who can check the bank app.
 *
 * `bills.amount_paid_ves` is untouched until that person confirms. A bill that
 * showed itself as paid because somebody typed a number into a form would be
 * worse than one that shows nothing, because the restaurant would stop asking.
 *
 * Takes no bill id, like every guest route: the table comes from the session.
 */
/**
 * Pedir desde la mesa.
 *
 * Las líneas entran en la cuenta en el acto -- no hay cola que alguien tenga
 * que aprobar -- y el panel se entera por el aviso que deja el pedido. Es la
 * decisión de producto: el comensal que pide desde su sitio no debe quedarse
 * esperando a que un mesero pulse "aceptar" en otra pantalla.
 *
 * De lo que sí se protege es de lo que no cuesta nada proteger: el límite por
 * sesión es más estrecho que el general de esta superficie (60/min), y el
 * esquema acota el pedido a veinte líneas de veinte unidades. El QR está pegado
 * a la mesa y cualquiera que lo fotografíe puede abrir sesión, así que lo que
 * cabe hacer es acotar el daño de un minuto malo, no fingir que no existe.
 *
 * La mesa no viaja en el cuerpo: la pone la sesión. Ver `placeOrder`.
 */
router.post(
  '/bill/orders',
  authenticateGuest,
  // Un pedido no es una consulta: diez por minuto son más de los que hace una
  // mesa entera en un servicio, y el que sobra ya no es un comensal pidiendo.
  rateLimit({ windowSeconds: 60, max: 10, keyPrefix: 'guest:order' }),
  validateBody(guestOrderSchema),
  async (req, res, next) => {
    const restaurantId = req.guest.restaurantId;
    let key = null;
    let claimed = false;
    try {
      key = orderIdempotencyKey(req);
      if (key) {
        const idem = await begin({ restaurantId, userId: null, key, hash: requestHash(req) });
        if (!idem.owner) return res.status(idem.response.status).json(idem.response.body);
        claimed = true;
      }

      const result = await guestOrders.placeOrder({
        restaurantId: req.guest.restaurantId,
        tableId: req.guest.tableId,
        guestSessionId: req.guest.sessionId ?? null,
        items: req.body.items,
        note: req.body.note || null
      });

      // PLACED: ya está en su cuenta, y ahí lo ve. HELD: es el primero de este
      // teléfono y el restaurante pide aprobarlo; lo sigue con
      // GET /bill/orders/:id.
      const body = {
        orderId: result.orderId,
        createdAt: result.createdAt,
        lineCount: req.body.items.length,
        status: result.status
      };
      // En cuanto el pedido existe, antes de nada más: si la auditoría o la
      // respuesta fallan, un reintento encuentra el pedido hecho y no lo
      // repite (`abort` sólo suelta claves sin respuesta guardada).
      if (claimed) await complete({ restaurantId, key, status: 201, body });

      await logAudit({
        restaurantId: req.guest.restaurantId,
        // Sin actor: no lo hizo nadie de la casa. La sesión que lo hizo queda
        // en `guest_orders.guest_session_id`, que es donde se puede seguir.
        actorId: null,
        action: result.status === 'HELD' ? 'GUEST_ORDER_HELD'
          : (result.opened ? 'BILL_OPENED_BY_GUEST_ORDER' : 'GUEST_ORDER_PLACED'),
        resourceType: 'guest_order',
        resourceId: result.orderId,
        // Si trae nota, pero no la nota: lo que escribe un comensal no va al
        // registro de auditoría.
        details: { tableId: req.guest.tableId, lines: req.body.items.length, hasNote: Boolean(req.body.note) },
        ip: req.ip,
        userAgent: req.get('user-agent'),
        requestId: req.id
      });

      res.status(201).json(body);
    } catch (err) {
      // Si el pedido no llegó a hacerse (placeOrder es una transacción), la
      // clave se suelta para que el reintento lo intente de verdad. Si se hizo,
      // ya tiene respuesta guardada y `abort` no la toca.
      if (claimed) {
        try { await abort({ restaurantId, key }); } catch (abortErr) {
          logger.error({ event: 'IDEMPOTENCY_ABORT_FAILED', err: abortErr }, 'Idempotency abort failed');
        }
      }
      next(err);
    }
  }
);

/** En qué quedó un pedido de este teléfono: el que espera aprobación lo consulta. */
router.get('/bill/orders/:id', authenticateGuest, perSession, validateParams(guestOrderIdParamSchema), async (req, res, next) => {
  try {
    const row = await guestOrders.statusForSession({
      restaurantId: req.guest.restaurantId,
      sessionId: req.guest.sessionId,
      orderId: req.params.id
    });
    res.json({
      orderId: row.id,
      status: row.status,
      createdAt: new Date(row.created_at).toISOString(),
      decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null
    });
  } catch (err) { next(err); }
});

module.exports = router;
