const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const invoicing = require('./fiscalInvoicing');
const { assertPlanAllows } = require('../middleware/plan');

/**
 * «Envíame la factura», cumplido cuando por fin se puede.
 *
 * El comensal lo pide al avisar de que pagó; la factura sólo puede emitirse
 * sobre un cobro confirmado, y eso lo hace una persona del local minutos
 * después. Esto es lo que une los dos momentos sin que el comensal tenga que
 * quedarse mirando la pantalla.
 *
 * Emite por el mismo camino que pedirla a mano -- `issueForPayment`, con la
 * misma puerta de plan y el mismo RIF -- para que no existan dos maneras de
 * hacer una factura que puedan llegar a discrepar. La entrega por correo la
 * programa ese mismo camino.
 *
 * Y una regla que manda sobre todo lo demás: **nada de aquí puede tumbar la
 * confirmación del cobro.** El dinero está verificado y la cuenta, saldada; que
 * la factura no salga es un problema de otra clase, se anota y se deja visible,
 * y el comensal todavía puede pedirla a mano. Por eso `fulfil` no lanza nunca.
 */

/** Los códigos que significan «esta factura ya existe», no «ha fallado». */
const ALREADY_DONE = new Set(['FISCAL_ALREADY_REQUESTED', 'FISCAL_NOTHING_TO_DECLARE']);

async function resolve(paymentId, status, errorCode = null) {
  await db.query(
    `UPDATE fiscal_invoice_intents
        SET status = $2, last_error_code = $3, resolved_at = now()
      WHERE payment_id = $1 AND status = 'WAITING'`,
    [paymentId, status, errorCode ? String(errorCode).slice(0, 80) : null]
  );
}

/**
 * Emite la factura que se pidió con este cobro, si se pidió.
 *
 * Devuelve en qué quedó (`ISSUED`, `FAILED`, `SKIPPED`) o `null` si no había
 * nada pedido. Se llama después de que la confirmación haya hecho commit: una
 * factura sobre un cobro cuya confirmación todavía puede deshacerse sería un
 * documento que quizá haya que anular.
 */
async function fulfil({ restaurantId, paymentId }) {
  try {
    const { rows } = await db.query(
      `SELECT i.email, i.customer_name, i.customer_tax_id, p.bill_id
         FROM fiscal_invoice_intents i
         JOIN payments p ON p.id = i.payment_id
        WHERE i.payment_id = $1 AND i.restaurant_id = $2 AND i.status = 'WAITING'`,
      [paymentId, restaurantId]
    );
    const intent = rows[0];
    if (!intent) return null;

    const provider = invoicing.activeProvider();
    if (!provider) {
      await resolve(paymentId, 'FAILED', 'FISCAL_PROVIDER_NOT_CONFIGURED');
      return 'FAILED';
    }

    let outcome;
    try {
      await assertPlanAllows(restaurantId, 'fiscalInvoicing');
      const result = await invoicing.issueForPayment({
        restaurantId,
        billId: intent.bill_id,
        paymentId,
        provider,
        customer: {
          name: intent.customer_name,
          taxId: intent.customer_tax_id,
          email: intent.email
        }
      });
      // Cualquier cosa que no sea ISSUED se anota como FAILED con su motivo.
      // UNCERTAIN -- sólo posible con imprenta externa -- deja además la
      // petición en la cola que mira una persona; al comensal no se le puede
      // decir que la factura va en camino cuando nadie lo sabe.
      outcome = result.status;
      await resolve(paymentId, outcome === 'ISSUED' ? 'ISSUED' : 'FAILED',
        outcome === 'ISSUED' ? null : result.reason ?? outcome);
    } catch (err) {
      if (ALREADY_DONE.has(err?.code)) {
        await resolve(paymentId, 'SKIPPED', err.code);
        return 'SKIPPED';
      }
      await resolve(paymentId, 'FAILED', err?.code ?? 'INTERNAL_ERROR');
      logger.warn({
        event: 'FISCAL_INTENT_FAILED', restaurantId, paymentId, code: err?.code
      }, 'La factura pedida con el aviso no se pudo emitir al confirmarlo');
      return 'FAILED';
    }

    logger.info({ event: 'FISCAL_INTENT_FULFILLED', restaurantId, paymentId, outcome },
      'Factura pedida con el aviso de pago, emitida al confirmarlo');
    return outcome === 'ISSUED' ? 'ISSUED' : 'FAILED';
  } catch (err) {
    // Hasta el último rincón: ni siquiera un fallo al leer o anotar la
    // intención puede salir de aquí hacia la confirmación del cobro.
    logger.error({ event: 'FISCAL_INTENT_ERROR', restaurantId, paymentId, err },
      'Error inesperado cumpliendo una factura pedida con el aviso');
    return 'FAILED';
  }
}

/** La petición de este cobro, para enseñársela a quien la hizo. */
async function forPayment(paymentId) {
  const { rows } = await db.query(
    `SELECT email, status FROM fiscal_invoice_intents WHERE payment_id = $1`,
    [paymentId]
  );
  return rows[0] ?? null;
}

module.exports = { fulfil, forPayment };
