/** The money end of a bill: settling it, voiding it, and taking a payment at the till. */
const express = require('express');
const db = require('../../connectors/base');
const { requireRole } = require('../../middleware/auth');
const {
  validateBody,
  validateParams,
  splitPaymentSchema,
  billIdParamSchema,
  settleBillSchema
} = require('../../middleware/schemas');
const { processSplitPayment } = require('../../services/locks');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const { requestHash, begin, complete, abort } = require('../../services/idempotency');
const { logAudit, auditContext } = require('../../services/audit');
const { logger } = require('../../connectors/logger');
const bills = require('../../services/bills');
const { BILL_COLUMNS } = bills;

const router = express.Router();

/**
 * Cerrar una cuenta con lo que de verdad entró.
 *
 * Una cuenta pasaba a CLOSED sola, y sólo cuando lo cobrado igualaba
 * **exactamente** lo debido; anularla exigía que no hubiera entrado un céntimo.
 * Entre los dos caminos quedaba un hueco por el que se cae media sala: la mesa
 * que paga 2.000 de 2.330 y se va, la cortesía sobre una cuenta que ya tenía
 * cobros, el plato devuelto después de pagar, el cero de más al teclear. En
 * todos esos casos la cuenta no se podía cerrar nunca -- anular se rechaza
 * porque hay dinero, y quitar líneas para cuadrarla se rechaza con
 * `TOTAL_BELOW_AMOUNT_PAID` -- y la mesa se quedaba ocupada para siempre.
 *
 * Esto la cierra y **escribe la diferencia con su motivo y su autor**. No toca
 * `amount_paid_ves`: lo cobrado sale del libro de pagos y es lo que se compara
 * contra el banco y contra la caja, así que sumar aquí un cobro que nadie hizo
 * cuadraría la cuenta y descuadraría el arqueo. Ver `037_bill_adjustments`.
 *
 * OWNER y MANAGER, porque es perdonar dinero, y auditado por lo mismo.
 *
 * Con la cuenta cuadrada no escribe ajuste ninguno: cerrar algo que no debe
 * nada es cerrarlo, no perdonar cero.
 */
router.post(
  '/:id/settle',
  requireRole('OWNER', 'MANAGER'),
  validateParams(billIdParamSchema),
  validateBody(settleBillSchema),
  async (req, res, next) => {
    try {
      const restaurantId = req.user.restaurantId;

      const result = await db.withTransaction(async client => {
        const { rows } = await client.query(
          `SELECT ${BILL_COLUMNS} FROM bills
            WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
          [req.params.id, restaurantId]
        );
        if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

        const bill = rows[0];
        if (bill.status !== 'OPEN') {
          throw new ApiError('BILL_NOT_OPEN', `A ${bill.status} bill cannot be settled`, {
            status: bill.status
          });
        }

        // Lo que se deja de cobrar. BigInt porque son unidades menores en
        // cadena y una cuenta puede pasar de 2^53 céntimos.
        const shortfall = BigInt(bill.total_due_ves) - BigInt(bill.amount_paid_ves);

        let adjustment = null;
        if (shortfall > 0n) {
          const written = await client.query(
            `INSERT INTO bill_adjustments
               (restaurant_id, bill_id, amount_ves, reason, note, created_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, amount_ves, reason, note, created_at`,
            [restaurantId, bill.id, shortfall.toString(), req.body.reason,
              req.body.note ?? null, req.user.sub]
          );
          adjustment = written.rows[0];
        }

        const closed = await client.query(
          `UPDATE bills SET status = 'CLOSED', updated_at = NOW()
            WHERE id = $1 AND restaurant_id = $2
          RETURNING ${BILL_COLUMNS}`,
          [bill.id, restaurantId]
        );

        return { bill: closed.rows[0], adjustment };
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_SETTLED',
        resourceType: 'bill',
        resourceId: result.bill.id,
        details: {
          reason: req.body.reason,
          // La cifra en la línea de auditoría y no sólo en la tabla: quien lee
          // el registro está buscando justamente cuánto se perdonó.
          adjustmentVes: result.adjustment ? result.adjustment.amount_ves : '0'
        }
      });

      res.json({
        bill: dto.bill(result.bill),
        adjustment: result.adjustment ? dto.billAdjustment(result.adjustment) : null
      });
    } catch (err) { next(err); }
  }
);

/**
 * Voids a bill that nobody has paid into.
 *
 * A bill carrying payments is deliberately not voidable: money has moved, and
 * reversing it is a refund, not a status change.
 */
router.post(
  '/:id/void',
  requireRole('OWNER', 'MANAGER'),
  validateParams(billIdParamSchema),
  async (req, res, next) => {
    try {
      const restaurantId = req.user.restaurantId;
      const rows = [await bills.voidBill({ restaurantId, billId: req.params.id })];

      await logAudit({
        ...auditContext(req),
        action: 'BILL_VOIDED',
        resourceType: 'bill',
        resourceId: rows[0].id
      });

      // Through the same mapper as every other bill response. This route used
      // to return the raw row, so a voided bill came back in a different shape
      // than the one that had just been read — both documented as `Bill`.
      res.json(dto.bill(rows[0]));
    } catch (err) { next(err); }
  }
);

router.post(
  '/:id/payments',
  requireRole('OWNER', 'MANAGER', 'CASHIER'),
  validateParams(billIdParamSchema),
  validateBody(splitPaymentSchema),
  async (req, res, next) => {
    if (req.body.billId !== req.params.id) {
      return next(new ApiError('BILL_ID_MISMATCH', 'billId does not match the URL'));
    }

    const key = req.get('Idempotency-Key') || req.body.idempotencyKey;
    const restaurantId = req.user.restaurantId;
    let claimed = false;

    try {
      const idem = await begin({ restaurantId, userId: req.user.sub, key, hash: requestHash(req) });
      if (!idem.owner) return res.status(idem.response.status).json(idem.response.body);
      claimed = true;

      const result = await processSplitPayment({
        restaurantId,
        billId: req.params.id,
        amountPaidMinorUnits: req.body.amountMinorUnits,
        // Recorded on the ledger row so a payment can be traced back to the
        // request and the person who took it.
        idempotencyKey: key,
        payer: { type: 'STAFF', id: req.user.sub },
        // Optional: settle one participant's share of a persistent split.
        splitParticipantId: req.body.splitParticipantId ?? null,
        // A tip taken at the till, on top of what settles the bill.
        tipVes: req.body.tipMinorUnits ?? '0',
        // How it arrived, which is what tells a cash tip already in the drawer
        // from an electronic one the restaurant still owes its staff.
        paymentMethod: req.body.paymentMethod ?? 'SPLITE'
      });

      // Store the response before replying, so a client retry that races the
      // response replays the stored result instead of double-charging.
      await complete({ restaurantId, key, status: 200, body: result });

      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_APPLIED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { amountMinorUnits: req.body.amountMinorUnits, currency: 'VES', status: result.status }
      });

      res.json(result);
    } catch (err) {
      // Release the claim only if this request owns it; a 409 from begin()
      // belongs to somebody else's in-flight request.
      if (claimed) {
        try { await abort({ restaurantId, key }); } catch (abortErr) {
          logger.error({ event: 'IDEMPOTENCY_ABORT_FAILED', billId: req.params.id, err: abortErr }, 'Idempotency abort failed');
        }
      }
      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_FAILED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { reason: err.message, status: err.statusCode || 500 }
      });
      next(err);
    }
  }
);

module.exports = router;
