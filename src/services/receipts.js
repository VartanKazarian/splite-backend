const db = require('../connectors/base');
const { ApiError } = require('../errors');
const { toMinor } = require('./money');
const { TAX_GROUPS_SQL, summariseTaxGroups } = require('./billItems');

/**
 * El recibo de un pago: la cuenta entera, y después lo que puso esta persona.
 *
 * El orden es el producto. Primero **la cuenta de la mesa completa** -- todos
 * los productos, con su cantidad y su precio unitario, el subtotal, el
 * servicio, el IVA por alícuota y el total --, y sólo al final «tú pagaste X».
 *
 * Eso no es una preferencia de maquetación. Es la única forma de que los cuatro
 * recibos de una mesa de cuatro se puedan poner uno al lado del otro y cuenten
 * la misma cena. Quien recibe un recibo con sólo su parte no tiene forma de
 * comprobar nada: ni que le cobraron lo que pidió, ni que la suma de las partes
 * es la cuenta, ni de discutirlo después con los demás. Con la cuenta entera
 * delante, las cuatro cuentas son la misma y sólo cambia el renglón de abajo.
 *
 * De ahí sale la invariante que gobierna este archivo, y que hay una prueba
 * que la fija: **la sección `bill` sólo depende de la cuenta.** No recibe el
 * pago, no lo mira y no puede variar entre comensales. Si algún día alguien
 * quiere «personalizarla», lo que quiere es otro documento.
 *
 * ## Esto no es una factura fiscal
 *
 * Un recibo prueba que hubo un cobro. No lleva número de control, no lo emite
 * una imprenta autorizada y no vale para desgravar. La factura fiscal es otra
 * cosa y se pide aparte; el recibo lo dice con esas palabras y no imita el
 * aspecto de un documento fiscal.
 */

const LINE_COLUMNS = `id, name_snapshot, quantity, unit_price_minor,
                      subtotal_minor, currency, tax_category, vat_bps`;

/**
 * La cuenta, su mesa y el local que la abrió.
 *
 * Una sola consulta con los tres JOIN porque el encabezado del recibo los pide
 * juntos y hacerlo en tres viajes deja la puerta abierta a que la cuenta y el
 * restaurante se lean en instantes distintos.
 */
async function loadBill(billId, restaurantId) {
  const { rows } = await db.query(
    `SELECT b.id, b.status, b.currency, b.created_at, b.updated_at,
            b.subtotal_minor, b.vat_minor, b.total_due,
            b.service_charge_bps, b.service_charge_minor,
            b.total_due_ves, b.amount_paid_ves, b.fx_rate_ves_per_unit,
            t.name AS table_name,
            r.name AS restaurant_name, r.rif AS restaurant_rif,
            r.fiscal_address AS restaurant_address
       FROM bills b
       JOIN tables t ON t.id = b.table_id
       JOIN restaurants r ON r.id = b.restaurant_id
      WHERE b.id = $1 AND b.restaurant_id = $2`,
    [billId, restaurantId]
  );
  if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
  return rows[0];
}

/**
 * La parte que es igual para toda la mesa.
 *
 * Toma el id de la cuenta y nada más: no hay ningún parámetro por el que
 * pudiera colarse algo de un comensal concreto, que es la manera de garantizar
 * la invariante en vez de prometerla en un comentario.
 */
async function billSection({ restaurantId, billId }) {
  const bill = await loadBill(billId, restaurantId);

  const [lines, groups] = await Promise.all([
    db.query(
      `SELECT ${LINE_COLUMNS} FROM bill_items
        WHERE bill_id = $1 AND restaurant_id = $2
        ORDER BY created_at, id`,
      [billId, restaurantId]
    ),
    db.query(TAX_GROUPS_SQL, [billId])
  ]);

  // El mismo cálculo que escribió los totales de la cuenta, no una copia suya.
  const { groups: taxes, subtotal, vat } = summariseTaxGroups(groups.rows);
  const serviceCharge = toMinor(bill.service_charge_minor ?? 0);

  return {
    restaurant: {
      name: bill.restaurant_name,
      rif: bill.restaurant_rif ?? null,
      address: bill.restaurant_address ?? null
    },
    table: { name: bill.table_name },
    bill: {
      id: bill.id,
      status: bill.status,
      currency: bill.currency,
      openedAt: bill.created_at,
      lines: lines.rows.map(line => ({
        id: line.id,
        name: line.name_snapshot,
        quantity: line.quantity,
        unitPriceMinor: String(line.unit_price_minor),
        subtotalMinor: String(line.subtotal_minor),
        taxCategory: line.tax_category,
        vatBps: line.vat_bps === null ? null : Number(line.vat_bps)
      })),
      subtotalMinor: subtotal.toString(),
      serviceChargeBps: bill.service_charge_bps ?? 0,
      serviceChargeMinor: serviceCharge.toString(),
      // Una fila por alícuota, que es como se declara y como se lee: una base
      // y su impuesto, no un número suelto al final.
      taxes: taxes.map(group => ({
        vatBps: group.vatBps,
        baseMinor: group.baseMinor.toString(),
        vatMinor: group.vatMinor.toString()
      })),
      vatMinor: vat.toString(),
      totalMinor: (subtotal + vat + serviceCharge).toString(),
      // La cuenta puede estar en una moneda de carta distinta del bolívar. El
      // total en Bs es el que se cobra, y va siempre.
      totalVes: String(bill.total_due_ves),
      fxRateVesPerUnit: bill.fx_rate_ves_per_unit ?? null
    }
  };
}

/**
 * El recibo de un pago concreto.
 *
 * `amount_ves` es lo que este cobro liquida de la cuenta y la propina va al
 * lado, nunca dentro -- ver la migración 024. Lo que la persona entregó de
 * verdad es la suma de los dos, y como es la cifra que va a comparar con el
 * mensaje de su banco, se da ya sumada en vez de dejarle la aritmética.
 */
async function forPayment({ restaurantId, paymentId }) {
  const { rows } = await db.query(
    `SELECT p.id, p.bill_id, p.status, p.payment_method, p.declared_reference,
            p.amount_ves, p.tip_ves, p.created_at, p.updated_at,
            (SELECT i.id FROM fiscal_invoices i WHERE i.payment_id = p.id LIMIT 1) AS invoice_id
       FROM payments p
      WHERE p.id = $1 AND p.restaurant_id = $2`,
    [paymentId, restaurantId]
  );
  const payment = rows[0];
  if (!payment) throw new ApiError('PAYMENT_NOT_FOUND', 'Payment not found');

  const amount = toMinor(payment.amount_ves);
  const tip = toMinor(payment.tip_ves ?? 0);

  return {
    ...await billSection({ restaurantId, billId: payment.bill_id }),
    payment: {
      id: payment.id,
      status: payment.status,
      method: payment.payment_method,
      reference: payment.declared_reference ?? null,
      amountVes: amount.toString(),
      tipVes: tip.toString(),
      handedOverVes: (amount + tip).toString(),
      declaredAt: payment.created_at,
      // Que ya tenga factura fiscal cambia lo que la pantalla debe ofrecer:
      // volver a ofrecerla invitaría a un segundo documento del mismo cobro.
      invoiced: Boolean(payment.invoice_id),
      invoiceId: payment.invoice_id ?? null
    }
  };
}

module.exports = { forPayment, billSection };
