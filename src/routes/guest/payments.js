/** A diner's own payment after the fact: its status and its receipt. */
const express = require('express');
const { validateParams, guestPaymentParamSchema } = require('../../middleware/schemas');
const { authenticateGuest } = require('../../services/guest');
const invoicing = require('../../services/fiscalInvoicing');
const receipts = require('../../services/receipts');
const { perSession, billForGuestPayment } = require('./shared');

const router = express.Router();

/**
 * En qué quedó un pago que declaró este comensal.
 *
 * Sin esto el teléfono no tenía forma de enterarse de que se lo confirmaron: el
 * aviso se creaba, se guardaba en memoria con estado PENDING y ahí se quedaba
 * para siempre. La pantalla prometía «podrás pedir la factura cuando el
 * restaurante confirme tu pago» y no existía el camino por el que esa promesa
 * pudiera cumplirse.
 *
 * Devuelve lo mínimo: en qué estado está y si ya tiene factura. Nada del resto
 * de la mesa -- quién más pagó y cuánto no es asunto de quien consulta.
 */
router.get(
  '/payments/:id',
  authenticateGuest,
  perSession,
  validateParams(guestPaymentParamSchema),
  async (req, res, next) => {
    try {
      const row = await billForGuestPayment(req.guest, req.params.id);
      res.json({
        id: row.payment_id,
        status: row.payment_status,
        amountVes: row.amount_ves,
        // Cuándo lo confirmó o rechazó el personal, para que el teléfono diga
        // «confirmado a las 21:14». Null mientras sigue por verificar. El motivo
        // de un rechazo no viaja: es una nota interna que escribe el personal.
        decidedAt: ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.payment_status)
          ? new Date(row.payment_updated_at).toISOString()
          : null,
        // Que la cuenta esté cerrada no impide pedir la factura: es más, suele
        // ser la señal de que ya se puede.
        billClosed: row.bill_status !== 'OPEN',
        invoiced: row.invoice_id !== null,
        // La factura de este cobro, cuando existe: su número y adónde se
        // manda. Sin esto, una factura emitida sola al confirmar el cobro era
        // invisible para quien la pidió -- `invoiced` escondía la oferta y
        // nada decía que ya estaba hecha.
        invoice: row.invoice_id !== null
          ? { controlNumber: row.invoice_control_number, email: row.invoice_email ?? null }
          : null,
        // La factura pedida al avisar del pago. WAITING mientras el cobro está
        // por confirmar; FAILED si al confirmarlo no se pudo emitir, que es
        // cuando la pantalla vuelve a ofrecer pedirla a mano.
        invoiceRequest: row.intent_status
          ? { email: row.intent_email, status: row.intent_status }
          : null,
        /*
         * Si en este restaurante se puede pedir factura, **dicho antes de que
         * el comensal lo intente**.
         *
         * Va aquí y no en la cuenta por la misma razón que el resto de este
         * endpoint: la cuenta se cierra justo cuando la factura empieza a poder
         * pedirse, así que una bandera que viviera allí desaparecería en el
         * único momento en que hace falta.
         *
         * Sin ella, la pantalla prometía «podrás pedir la factura cuando el
         * restaurante confirme tu pago» sin comprobar nada, y el comensal se
         * enteraba de que aquí no se piden al pulsar -- ya confirmado el cobro,
         * y habiendo dejado de pedírsela al personal porque la app le dijo que
         * esperara.
         */
        canRequestInvoice: invoicing.canIssue({
          planTier: row.plan_tier, hasSeries: row.has_series, hasRif: row.has_rif
        })
      });
    } catch (err) { next(err); }
  }
);

/**
 * El recibo de un cobro: la cuenta entera y, debajo, lo que puso esta persona.
 *
 * **La cuenta completa y no sólo su parte**, que es la decisión de producto de
 * todo esto. Los recibos de una mesa de cuatro tienen que poder ponerse uno al
 * lado del otro y contar la misma cena: mismos productos, mismo subtotal, mismo
 * IVA, mismo total. Lo único que cambia entre ellos es el último bloque. Un
 * recibo con sólo la parte de uno no deja comprobar nada -- ni que le cobraron
 * lo que pidió, ni que las partes suman la cuenta.
 *
 * Anclado al pago y no a la cuenta abierta, por lo mismo que la factura: el
 * recibo se mira justo después de que confirmen el cobro, que es el instante en
 * que la cuenta se cierra. Pedirlo contra `openBillForGuest` lo haría imposible
 * exactamente cuando hace falta.
 *
 * El aislamiento va aquí y no en el servicio: `billForGuestPayment` exige que
 * el pago sea de **la mesa de esta sesión**, y el servicio sólo sabe de
 * restaurante. Las dos vallas, y en este orden.
 *
 * **No es una factura fiscal** y no se parece a una: sin número de control,
 * sin imprenta autorizada y sin valor para desgravar. Esa se pide aparte.
 */
router.get(
  '/payments/:id/receipt',
  authenticateGuest,
  perSession,
  validateParams(guestPaymentParamSchema),
  async (req, res, next) => {
    try {
      await billForGuestPayment(req.guest, req.params.id);
      res.json(await receipts.forPayment({
        restaurantId: req.guest.restaurantId,
        paymentId: req.params.id
      }));
    } catch (err) { next(err); }
  }
);

module.exports = router;
