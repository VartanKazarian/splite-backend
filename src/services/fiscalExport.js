const db = require('../connectors/base');

/**
 * Las facturas de un mes, en una hoja para el contador.
 *
 * Lo que esto es y lo que no. Es un **resumen** de los documentos que Splite
 * guardó, uno por fila, con la base y el IVA separados por alícuota: lo que un
 * contador necesita para cuadrar el libro de ventas sin copiar factura por
 * factura. **No es el libro de ventas oficial** ni se presenta como tal: su
 * formato lo fija la normativa del SENIAT y lo lleva el contador, y un fichero
 * que dijera serlo sin que nadie lo haya certificado sería una afirmación
 * falsa. La pantalla lo dice igual.
 *
 * Decisiones que no se ven en el código:
 *
 *   - **El mes es el de Caracas**, no el de UTC. Una cena pagada el 30 a las
 *     22:00 es de ese día para el restaurante, y en UTC ya sería el 1 del mes
 *     siguiente: saldría en el fichero equivocado.
 *   - **Las notas de crédito restan.** Se guardan con importes positivos (el
 *     documento dice cuánto compensa), pero en una suma de ventas del mes una
 *     nota de crédito baja la venta. Con el signo puesto, sumar la columna da
 *     el total correcto sin tener que filtrar por tipo.
 *   - **Punto y coma y coma decimal.** Es lo que abre bien un Excel en español
 *     con doble clic; con comas como separador, cada importe se partía en dos
 *     columnas. Sin separador de miles, para que la hoja lo lea como número.
 *   - **Nada de fórmulas.** El nombre del cliente lo escribe un comensal. Un
 *     nombre que empiece por «=» se ejecutaría como fórmula al abrir la hoja en
 *     el ordenador del contador; se neutraliza anteponiendo un apóstrofo.
 */

/** Cuántos documentos como mucho. Un restaurante no emite tantos en un mes; un error sí. */
const MAX_ROWS = 50000;

const TYPE_LABEL = {
  INVOICE: 'Factura',
  CREDIT_NOTE: 'Nota de crédito',
  DEBIT_NOTE: 'Nota de débito'
};

/** «2026-09» → válido. El formato lo garantiza el esquema; esto es la segunda valla. */
function parseMonth(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month ?? ''));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** Céntimos → «1234,56», con signo. Sin aritmética de coma flotante: se recorta la cadena. */
function money(minor, sign = 1n) {
  const value = BigInt(minor ?? 0) * sign;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)},${digits.slice(-2)}`;
}

/** 1600 → «16%», 1250 → «12,5%». */
function rateLabel(bps) {
  const whole = Math.trunc(bps / 100);
  const frac = String(bps % 100).padStart(2, '0').replace(/0+$/, '');
  return frac ? `${whole},${frac}%` : `${whole}%`;
}

/**
 * Una celda de texto, segura para una hoja de cálculo.
 *
 * Primero se neutraliza lo que la hoja tomaría por fórmula (OWASP, «CSV
 * injection»), después se entrecomilla si hace falta.
 */
function textCell(value) {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[";\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Los documentos, ya cargados, a CSV.
 *
 * Pura: todo lo que decide qué dice el fichero se prueba sin base de datos.
 * `docs` trae, por documento, sus impuestos por alícuota (`taxes`).
 */
function buildCsv(docs) {
  // Las alícuotas gravadas que aparecen en el mes, cada una con su par de
  // columnas. Fijarlas de antemano (16 %, 8 %) dejaría fuera la que el
  // restaurante tenga configurada si es otra.
  const rates = [...new Set(
    docs.flatMap(d => d.taxes.filter(t => t.tax_category === 'TAXABLE' && t.vat_bps > 0).map(t => t.vat_bps))
  )].sort((a, b) => b - a);

  const header = [
    'Fecha', 'Tipo', 'Nº documento', 'Nº control', 'Documento afectado',
    'RIF o cédula del cliente', 'Cliente', 'Mesa',
    'Exento o no sujeto (Bs)',
    ...rates.flatMap(r => [`Base ${rateLabel(r)} (Bs)`, `IVA ${rateLabel(r)} (Bs)`]),
    'Servicio (Bs)', 'Total (Bs)', 'Documento de prueba'
  ];

  const lines = [header.map(textCell).join(';')];
  for (const d of docs) {
    const sign = d.document_type === 'CREDIT_NOTE' ? -1n : 1n;
    let exempt = 0n;
    const byRate = new Map(rates.map(r => [r, { base: 0n, vat: 0n }]));
    for (const t of d.taxes) {
      if (t.tax_category === 'TAXABLE' && t.vat_bps > 0) {
        const slot = byRate.get(t.vat_bps);
        slot.base += BigInt(t.base_minor);
        slot.vat += BigInt(t.vat_minor);
      } else {
        exempt += BigInt(t.base_minor);
      }
    }
    const row = [
      textCell(d.issued_date),
      textCell(TYPE_LABEL[d.document_type] ?? d.document_type),
      textCell(d.document_number),
      textCell(d.control_number),
      textCell(d.compensates_number ?? ''),
      textCell(d.customer_tax_id ?? ''),
      textCell(d.customer_name ?? (d.customer_tax_id ? '' : 'Consumidor final')),
      textCell(d.table_name ?? ''),
      money(exempt, sign),
      ...rates.flatMap(r => [money(byRate.get(r).base, sign), money(byRate.get(r).vat, sign)]),
      money(d.service_minor, sign),
      money(d.total_minor, sign),
      textCell(d.provider === 'mock' ? 'Sí' : 'No')
    ];
    lines.push(row.join(';'));
  }
  // BOM: sin él, Excel abre el fichero como Latin-1 y «Nº» sale «NÂº».
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/**
 * Los documentos del restaurante en ese mes de Caracas, con sus impuestos.
 *
 * Todo atado al restaurante, incluida la unión con el documento compensado: una
 * nota de crédito no puede traer el número de una factura ajena.
 */
async function load({ restaurantId, month }) {
  const parsed = parseMonth(month);
  if (!parsed) throw new Error('month must be YYYY-MM');
  const first = `${parsed.year}-${String(parsed.month).padStart(2, '0')}-01`;

  const { rows: docs } = await db.query(
    `SELECT fi.id, fi.document_type, fi.document_number, fi.control_number, fi.provider,
            fi.subtotal_minor, fi.vat_minor, fi.service_minor, fi.total_minor,
            fi.customer_name, fi.customer_tax_id,
            to_char(fi.issued_at AT TIME ZONE 'America/Caracas', 'DD/MM/YYYY') AS issued_date,
            comp.document_number AS compensates_number,
            t.name AS table_name
       FROM fiscal_invoices fi
       LEFT JOIN fiscal_invoices comp
              ON comp.id = fi.compensates_id AND comp.restaurant_id = fi.restaurant_id
       LEFT JOIN bills b ON b.id = fi.bill_id AND b.restaurant_id = fi.restaurant_id
       LEFT JOIN tables t ON t.id = b.table_id AND t.restaurant_id = fi.restaurant_id
      WHERE fi.restaurant_id = $1
        AND fi.issued_at >= ($2::date)::timestamp AT TIME ZONE 'America/Caracas'
        AND fi.issued_at < (($2::date + interval '1 month'))::timestamp AT TIME ZONE 'America/Caracas'
      ORDER BY fi.issued_at, fi.document_number
      LIMIT $3`,
    [restaurantId, first, MAX_ROWS + 1]
  );
  if (docs.length > MAX_ROWS) {
    throw new Error(`more than ${MAX_ROWS} fiscal documents in ${month}`);
  }

  const ids = docs.map(d => d.id);
  const { rows: taxes } = ids.length
    ? await db.query(
      `SELECT invoice_id, tax_category, vat_bps, base_minor, vat_minor
         FROM fiscal_invoice_taxes
        WHERE restaurant_id = $1 AND invoice_id = ANY($2::uuid[])`,
      [restaurantId, ids]
    )
    : { rows: [] };
  const byInvoice = new Map(ids.map(id => [id, []]));
  for (const t of taxes) byInvoice.get(t.invoice_id)?.push(t);

  return docs.map(d => ({ ...d, taxes: byInvoice.get(d.id) ?? [] }));
}

function filenameFor(month) {
  return `facturas-${month}.csv`;
}

module.exports = { buildCsv, load, filenameFor, parseMonth, textCell, money, rateLabel, MAX_ROWS };
