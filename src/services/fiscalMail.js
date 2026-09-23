const db = require('../connectors/base');
const mailer = require('./mailer');
const { logger } = require('../connectors/logger');

/**
 * La factura, en el correo de quien la pidió.
 *
 * Dos reglas gobiernan este archivo, y las dos son sobre lo que **no** puede
 * pasar.
 *
 * **Un fallo de correo no toca la factura.** El documento existe, está
 * declarado y es válido haya llegado el correo o no. Lo que falta cuando el
 * envío falla es una entrega, no una factura, así que nada de aquí se ejecuta
 * dentro de la transacción que la escribe y nada de aquí puede lanzar hacia
 * ella. La fila de entrega se crea con el documento -- para que no exista una
 * factura con correo y sin rastro de envío -- y el envío ocurre después.
 *
 * **Un documento simulado no se disfraza de factura fiscal.** El proveedor
 * `mock` emite números inventados con prefijo MOCK, y el correo lo dice en la
 * primera línea. Entregar uno de esos a un comensal como si fuera bueno es un
 * problema tributario con sanción; `assertProductionConfig` ya impide que el
 * simulado arranque en producción, y esto es la segunda valla.
 */

/** 9756 -> "97,56". Sin coma flotante: el dinero es entero en céntimos. */
function money(minor) {
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole},${cents}`;
}

/**
 * Una línea de «concepto ....... importe», con el importe alineado a la
 * derecha.
 *
 * Se lee en un cliente de correo de ancho fijo, así que alinear no es adorno:
 * una columna de cifras dentadas obliga a leer dígito a dígito para comprobar
 * que el total es la suma de lo de arriba, que es lo primero que hace quien
 * recibe una factura.
 */
const WIDTH = 56;
function row(label, amount) {
  const right = `${amount} Bs`;
  return label.padEnd(WIDTH - right.length, ' ').slice(0, Math.max(0, WIDTH - right.length)) + right;
}

/**
 * Parte un párrafo en líneas de 72 caracteres, sin cortar palabras.
 *
 * El correo es texto plano y hay clientes que no ajustan: un párrafo de una
 * sola línea de cuatrocientos caracteres sale con barra de desplazamiento
 * horizontal, o cortado.
 */
function wrap(text, width = 72) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (!line.length) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { out.push(line); line = word; }
  }
  if (line.length) out.push(line);
  return out;
}

/** 1600 -> "16,00 %". */
function rate(bps) {
  return `${Math.trunc(bps / 100)},${String(bps % 100).padStart(2, '0')} %`;
}

/** 2000 milésimas -> "2"; 338 -> "0,338". Prorratear da cantidades fraccionarias. */
function quantity(milli) {
  const n = BigInt(milli);
  if (n % 1000n === 0n) return (n / 1000n).toString();
  return `${n / 1000n},${(n % 1000n).toString().padStart(3, '0')}`;
}

/**
 * Cómo se construyeron las líneas, explicado a quien lo va a leer.
 *
 * `PRORATED` produce cantidades como «0,338 de hamburguesa», que sin una frase
 * al lado parece un error. Lo es sólo en apariencia: el importe es exactamente
 * lo que esa persona pagó, y la fealdad es lo que significa prorratear.
 */
const BASIS_NOTE = {
  ITEMISED: 'Las líneas son los productos que reclamaste al dividir la cuenta.',
  PRORATED: 'Las cantidades están prorrateadas sobre la cuenta de la mesa en '
    + 'proporción a lo que pagaste, así que pueden salir fraccionadas. El total '
    + 'es exactamente lo que pagaste.',
  AGGREGATE: 'Se declara como una sola línea de consumo sobre la cuenta de la mesa.'
};

/**
 * El cuerpo del correo.
 *
 * Texto plano porque el mailer manda texto plano -- ver `mailer.js`, que es un
 * puerto con tres adaptadores y un solo campo de cuerpo. Un documento fiscal se
 * lee igual de bien en texto, y añadir HTML obligaría a tocar los tres.
 */
function compose({ invoice, restaurant, lines, taxes, tableName }) {
  const simulated = invoice.provider === 'mock';
  const out = [];

  if (simulated) {
    out.push(
      '*** DOCUMENTO DE PRUEBA -- NO ES UNA FACTURA FISCAL ***',
      'Lo emitió un proveedor simulado y sus números son inventados. No sirve',
      'para desgravar ni tiene validez ante el SENIAT.',
      ''
    );
  }

  out.push(
    `${restaurant.name}${restaurant.rif ? ` · RIF ${restaurant.rif}` : ''}`,
    ...(restaurant.fiscal_address ? [restaurant.fiscal_address] : []),
    '',
    `Factura       ${invoice.document_number}`,
    `Nº de control ${invoice.control_number}`,
    `Fecha         ${new Date(invoice.issued_at).toISOString().slice(0, 10)}`,
    ...(tableName ? [`Mesa          ${tableName}`] : []),
    // Consumidor final es el caso mayoritario y se escribe como tal, no como un
    // hueco: la mayoría de la gente no da su cédula por una cena.
    `Receptor      ${invoice.customer_name || invoice.customer_tax_id
      ? [invoice.customer_name, invoice.customer_tax_id].filter(Boolean).join(' · ')
      : 'Consumidor final'}`,
    '',
    'DETALLE'
  );

  for (const line of lines) {
    out.push(row(`  ${quantity(line.quantity_milli)} x ${line.description}`, money(line.base_minor)));
  }

  out.push('', 'IMPUESTOS');
  for (const tax of taxes) {
    const label = Number(tax.vat_bps) === 0 ? 'Sin IVA' : `IVA ${rate(Number(tax.vat_bps))}`;
    out.push(row(`  ${label.padEnd(14)} base ${money(tax.base_minor)} Bs`, money(tax.vat_minor)));
  }

  out.push(
    '',
    row('  Base imponible', money(invoice.subtotal_minor)),
    row('  IVA', money(invoice.vat_minor)),
    ...(BigInt(invoice.service_minor) > 0n
      ? [row('  Servicio', money(invoice.service_minor))]
      : []),
    row('  TOTAL', money(invoice.total_minor)),
    '',
    ...wrap(BASIS_NOTE[invoice.line_basis] ?? ''),
    '',
    ...wrap('Recibes este correo porque pediste tu factura al pagar. No es '
      + 'publicidad y no te hemos apuntado a ninguna lista.'),
    '',
    // Sale de una dirección que no recibe respuestas, y lo primero que hace
    // quien ve un error en su factura es contestar. Se dice adónde escribir en
    // vez de dejar que la respuesta se pierda -- y, si el restaurante no dejó
    // correo, que la corrección se pide allí.
    ...wrap(restaurant.contact_email
      ? `Si algo de tu factura no está bien, responde a este correo: la respuesta `
        + `le llega a ${restaurant.name} (${restaurant.contact_email}).`
      : `Este correo sale de una dirección que no recibe respuestas. Si algo de tu `
        + `factura no está bien, pídele la corrección a ${restaurant.name}.`)
  );

  return {
    to: invoice.customer_email,
    // El restaurante en el remitente, para que se reconozca en la bandeja: la
    // factura es suya, no nuestra. La dirección sigue siendo la verificada.
    fromName: `${restaurant.name} vía Splite`,
    ...(restaurant.contact_email ? { replyTo: restaurant.contact_email } : {}),
    subject: simulated
      ? `[PRUEBA] Documento ${invoice.document_number} — ${restaurant.name}`
      : `Tu factura ${invoice.document_number} — ${restaurant.name}`,
    text: out.join('\n')
  };
}

/** Todo lo que el correo necesita, en una consulta por tabla. */
async function load(invoiceId) {
  const { rows } = await db.query(
    `SELECT i.*, r.name AS restaurant_name, r.rif AS restaurant_rif,
            r.fiscal_address AS restaurant_address, r.contact_email AS restaurant_contact_email,
            t.name AS table_name
       FROM fiscal_invoices i
       JOIN restaurants r ON r.id = i.restaurant_id
       LEFT JOIN bills b ON b.id = i.bill_id
       LEFT JOIN tables t ON t.id = b.table_id
      WHERE i.id = $1`,
    [invoiceId]
  );
  if (!rows.length) return null;

  const [lines, taxes] = await Promise.all([
    db.query(
      `SELECT description, quantity_milli, base_minor FROM fiscal_invoice_lines
        WHERE invoice_id = $1 ORDER BY position`, [invoiceId]
    ),
    db.query(
      `SELECT vat_bps, base_minor, vat_minor FROM fiscal_invoice_taxes
        WHERE invoice_id = $1 ORDER BY vat_bps`, [invoiceId]
    )
  ]);

  return {
    invoice: rows[0],
    restaurant: {
      name: rows[0].restaurant_name,
      rif: rows[0].restaurant_rif,
      fiscal_address: rows[0].restaurant_address,
      contact_email: rows[0].restaurant_contact_email ?? null
    },
    tableName: rows[0].table_name ?? null,
    lines: lines.rows,
    taxes: taxes.rows
  };
}

/**
 * Anota que hay que mandar esta factura. **Dentro** de la transacción que la
 * escribe, para que no pueda existir una factura con correo y sin rastro de
 * envío.
 *
 * `ON CONFLICT DO NOTHING` porque el índice único ya decide: un documento no se
 * manda dos veces a la misma dirección.
 */
async function scheduleDelivery(client, { restaurantId, invoiceId, email }) {
  if (!email) return null;
  const { rows } = await client.query(
    `INSERT INTO fiscal_invoice_deliveries (restaurant_id, invoice_id, email)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [restaurantId, invoiceId, email]
  );
  return rows[0]?.id ?? null;
}

/** Cuántos intentos antes de dejar de insistir y que lo mire una persona. */
const MAX_ATTEMPTS = 5;

/**
 * Intenta una entrega y anota lo que pasó. **Nunca lanza.**
 *
 * Devuelve el estado en el que queda, para que quien la llame pueda contarlo
 * sin volver a consultar. Un error del proveedor deja la fila en FAILED con su
 * motivo recortado -- el cuerpo de error puede devolver la dirección del
 * destinatario, y esto se lee desde el panel.
 */
async function attemptDelivery(deliveryId) {
  const { rows } = await db.query(
    `SELECT d.id, d.invoice_id, d.email, d.attempts, d.status
       FROM fiscal_invoice_deliveries d WHERE d.id = $1`, [deliveryId]
  );
  const delivery = rows[0];
  if (!delivery) return { status: 'MISSING' };
  if (delivery.status === 'SENT') return { status: 'SENT' };
  if (delivery.attempts >= MAX_ATTEMPTS) return { status: 'FAILED', exhausted: true };

  const loaded = await load(delivery.invoice_id);
  if (!loaded) return { status: 'MISSING' };

  const message = compose(loaded);
  // El correo de la entrega manda sobre el de la factura: un reenvío a una
  // dirección corregida tiene que ir a la corregida.
  const result = await mailer.send({ ...message, to: delivery.email });

  // `mailer.send` no lanza nunca: contesta { sent } y deja decidir aquí.
  if (!result.sent) {
    await db.query(
      `UPDATE fiscal_invoice_deliveries
          SET status = 'FAILED', attempts = attempts + 1,
              last_error = $2, updated_at = now()
        WHERE id = $1`,
      [deliveryId, String(result.error ?? 'unknown').slice(0, 300)]
    );
    logger.warn({ event: 'FISCAL_MAIL_FAILED', deliveryId, invoiceId: delivery.invoice_id },
      'No se pudo entregar la factura por correo');
    return { status: 'FAILED' };
  }

  await db.query(
    `UPDATE fiscal_invoice_deliveries
        SET status = 'SENT', attempts = attempts + 1, sent_at = now(),
            provider_message_id = $2, last_error = NULL, updated_at = now()
      WHERE id = $1`,
    [deliveryId, result.id ?? null]
  );
  logger.info({ event: 'FISCAL_MAIL_SENT', deliveryId, invoiceId: delivery.invoice_id },
    'Factura entregada por correo');
  return { status: 'SENT' };
}

/**
 * Lo que quedó sin mandar, reintentado.
 *
 * Existe porque el envío del camino caliente **no se espera**: la respuesta al
 * comensal no debe colgar de un SMTP que puede tardar diez segundos. El precio
 * de eso es que un proceso que se reinicia a mitad deja la fila en PENDING, y
 * sin este barrido esa factura no se mandaría nunca.
 *
 * Lo más viejo primero, como la cola de dudas: una factura de ayer que no ha
 * llegado es más urgente que una de hace un minuto.
 */
async function sweepPending({ limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT id FROM fiscal_invoice_deliveries
      WHERE status <> 'SENT' AND attempts < $2
      ORDER BY created_at
      LIMIT $1`,
    [limit, MAX_ATTEMPTS]
  );

  const counts = { attempted: 0, sent: 0, failed: 0 };
  for (const pending of rows) {
    counts.attempted += 1;
    const result = await attemptDelivery(pending.id);
    if (result.status === 'SENT') counts.sent += 1;
    else counts.failed += 1;
  }
  return counts;
}

/**
 * El envío del camino caliente, sin esperarlo.
 *
 * Se llama después de que la factura esté escrita y **no se aguarda**: el
 * comensal ya tiene su número de control en pantalla y no tiene por qué esperar
 * a un correo. Si el proceso muere antes de terminar, la fila se queda en
 * PENDING y la recoge `sweepPending`, que es justo para lo que existe.
 */
function deliverInBackground(deliveryId) {
  if (!deliveryId) return;
  attemptDelivery(deliveryId).catch(err => {
    // attemptDelivery no lanza; esto cubre un fallo de la propia base de datos
    // al anotar el resultado. Tampoco puede propagarse: no hay nadie esperando.
    logger.error({ event: 'FISCAL_MAIL_CRASHED', deliveryId, err },
      'El envío de la factura falló fuera del camino de la petición');
  });
}

module.exports = {
  compose, scheduleDelivery, attemptDelivery, sweepPending, deliverInBackground,
  MAX_ATTEMPTS,
  // Exportados para las pruebas del formato, que es donde se ve un céntimo mal.
  _internals: { money, rate, quantity }
};
