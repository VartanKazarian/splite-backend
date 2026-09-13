const crypto = require('crypto');

const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');
const { applyBps } = require('./money');
const { allocate } = require('./split');
const { stateFromLines, outstandingOf } = require('./fiscalAllocation');
const { resolveLineBasis, buildDraft } = require('./fiscalInvoiceBuilder');
const providers = require('../fiscal/providers');

/**
 * Emitir la factura de un pago, sin llegar nunca a emitirla dos veces.
 *
 * El recorrido es corto y el peligro está todo en un sitio: entre pedirle la
 * emisión al proveedor y saber si la hizo. Una respuesta que no lo aclara deja
 * dos salidas evidentes y las dos están mal -- reintentar declara la venta dos
 * veces, y darlo por fallido deja al comensal sin factura y al restaurante con
 * una venta sin documentar.
 *
 * Así que la regla es: ante la duda se **pregunta**, y si tampoco se puede
 * preguntar, el caso queda en una cola que mira una persona. Dejar algo
 * pendiente es un desenlace legítimo aquí; inventarse cuál fue no lo es.
 */

const vatOf = (base, bps) => applyBps(base, bps, 'IVA');

/**
 * Lo que a esta cuenta le queda por declarar.
 *
 * Se deriva -- no se guarda. El estado son las líneas de la cuenta menos lo que
 * ya declararon las facturas emitidas sobre ella. Una columna de «pendiente por
 * declarar» sería un segundo sitio donde vive la verdad, y se desincronizaría a
 * la primera factura que se emitiera por un camino que no la actualice.
 */
async function stateForBill(client, { restaurantId, billId }) {
  const bill = await client.query(
    `SELECT id, table_id, currency, subtotal_minor, vat_minor, service_charge_minor,
            total_due, total_due_ves, fx_rate_ves_per_unit
       FROM bills WHERE id = $1 AND restaurant_id = $2`,
    [billId, restaurantId]
  );
  if (!bill.rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
  const row = bill.rows[0];

  const items = await client.query(
    `SELECT id, name_snapshot, quantity, unit_price_minor, subtotal_minor,
            COALESCE(tax_category, 'TAXABLE') AS tax_category, COALESCE(vat_bps, 0) AS vat_bps
       FROM bill_items WHERE bill_id = $1 ORDER BY created_at, id`,
    [billId]
  );

  const lines = items.rows.map(item => ({
    id: item.id,
    name: item.name_snapshot,
    quantity: Number(item.quantity),
    unitPriceMinor: BigInt(item.unit_price_minor),
    subtotalMinor: BigInt(item.subtotal_minor),
    taxCategory: item.tax_category,
    vatBps: Number(item.vat_bps)
  }));

  let state = stateFromLines(lines, {
    serviceMinor: BigInt(row.service_charge_minor ?? 0), vatOf
  });

  // Una factura venezolana se declara en bolívares. Cuando la carta está en
  // otra moneda hay que convertir, y la conversión tiene que ser exacta: se
  // reparte `total_due_ves` entre los componentes con el mismo motor de resto
  // mayor, en vez de convertir cada uno y sumar -- que descuadraría contra el
  // total que la cuenta ya tiene guardado y que es el que se cobró.
  //
  // La tasa es la congelada en la cuenta. No se vuelve a consultar el BCV: una
  // factura recalculada a la tasa de hoy declararía algo distinto de lo cobrado.
  if (row.currency !== 'VES') {
    state = toVes(state, BigInt(row.total_due_ves));
  }

  const declared = await client.query(
    `SELECT COALESCE(t.vat_bps, 0) AS vat_bps,
            COALESCE(SUM(t.base_minor), 0)::TEXT AS base,
            COALESCE(SUM(t.vat_minor), 0)::TEXT AS vat
       FROM fiscal_invoice_taxes t
       JOIN fiscal_invoices i ON i.id = t.invoice_id
      WHERE i.bill_id = $1 AND i.document_type = 'INVOICE'
      GROUP BY COALESCE(t.vat_bps, 0)`,
    [billId]
  );
  const service = await client.query(
    `SELECT COALESCE(SUM(service_minor), 0)::TEXT AS service
       FROM fiscal_invoices WHERE bill_id = $1 AND document_type = 'INVOICE'`,
    [billId]
  );

  const byRate = new Map(declared.rows.map(r => [Number(r.vat_bps), r]));
  const groups = state.groups.map(group => {
    const already = byRate.get(group.vatBps);
    return {
      vatBps: group.vatBps,
      baseMinor: group.baseMinor - BigInt(already?.base ?? 0),
      vatMinor: group.vatMinor - BigInt(already?.vat ?? 0)
    };
  });

  return {
    bill: row,
    lines,
    state: { groups, serviceMinor: state.serviceMinor - BigInt(service.rows[0].service) }
  };
}

/** Convierte el estado a bolívares repartiendo el total ya guardado. */
function toVes(state, totalVes) {
  const buckets = [
    ...state.groups.flatMap(g => [g.baseMinor, g.vatMinor]),
    state.serviceMinor
  ];
  const sum = buckets.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return state;

  const positive = [];
  buckets.forEach((value, index) => { if (value > 0n) positive.push(index); });
  const parts = new Array(buckets.length).fill(0n);
  const allocated = allocate(totalVes, positive.map(i => buckets[i]));
  positive.forEach((index, k) => { parts[index] = BigInt(allocated[k]); });

  return {
    groups: state.groups.map((group, i) => ({
      vatBps: group.vatBps, baseMinor: parts[i * 2], vatMinor: parts[i * 2 + 1]
    })),
    serviceMinor: parts[buckets.length - 1]
  };
}

/**
 * Qué reclamó esta persona, si es que se puede saber.
 *
 * Sólo el reparto por producto lo registra. Una línea que reclaman varios se
 * divide entre ellos -- con `allocate`, para que las partes sumen la línea.
 */
async function claimedLines(client, { paymentId, lines }) {
  const { rows } = await client.query(
    `SELECT s.mode, p.id AS participant_id, p.amount_ves
       FROM payments pay
       JOIN bill_split_participants p ON p.id = pay.split_participant_id
       JOIN bill_splits s ON s.id = p.split_id
      WHERE pay.id = $1`,
    [paymentId]
  );
  if (!rows.length) return { splitMode: null, share: null, claimed: null };
  const { mode, participant_id: participantId, amount_ves: share } = rows[0];
  if (mode !== 'ITEMS') return { splitMode: mode, share: BigInt(share), claimed: null };

  const claims = await client.query(
    `SELECT bill_item_id, participant_id FROM bill_split_items
      WHERE split_id = (SELECT split_id FROM bill_split_participants WHERE id = $1)`,
    [participantId]
  );

  const claimants = new Map();
  for (const row of claims.rows) {
    claimants.set(row.bill_item_id, (claimants.get(row.bill_item_id) ?? 0) + 1);
  }

  const mine = claims.rows.filter(r => r.participant_id === participantId);
  const byId = new Map(lines.map(l => [l.id, l]));

  const claimed = mine.map(row => {
    const line = byId.get(row.bill_item_id);
    if (!line) return null;
    const count = claimants.get(row.bill_item_id) ?? 1;
    // Un plato compartido se parte entre quienes lo reclamaron. `allocate` deja
    // el céntimo suelto en la primera parte en vez de perderlo.
    const portion = count > 1
      ? BigInt(allocate(line.subtotalMinor, Array(count).fill(1))[0])
      : line.subtotalMinor;
    return { ...line, shareMinor: portion, fullMinor: line.subtotalMinor };
  }).filter(Boolean);

  return { splitMode: mode, share: BigInt(share), claimed };
}

/**
 * Emite la factura de un pago.
 *
 * Se apoya en dos barreras que ya existen y que no duplica: el índice único que
 * impide dos peticiones por el mismo cobro, y la idempotencia que el proveedor
 * reconoce por clave. La primera evita el duplicado desde este lado; la segunda,
 * desde el suyo.
 */
async function issueForPayment({ restaurantId, billId, paymentId, customer = {}, provider }) {
  const prepared = await db.withTransaction(async (client) => {
    const { bill, lines, state } = await stateForBill(client, { restaurantId, billId });

    const payment = await client.query(
      `SELECT id, amount_ves, status FROM payments
        WHERE id = $1 AND restaurant_id = $2 AND bill_id = $3`,
      [paymentId, restaurantId, billId]
    );
    if (!payment.rows.length) throw new ApiError('PAYMENT_NOT_FOUND', 'Payment not found');
    if (payment.rows[0].status !== 'SUCCEEDED') {
      // Facturar un cobro que aún no se sabe si entró produciría un documento
      // que quizá haya que compensar mañana. Se espera.
      throw new ApiError('PAYMENT_STATE_INVALID', 'Only a settled payment can be invoiced',
        { status: payment.rows[0].status });
    }

    const paidMinor = BigInt(payment.rows[0].amount_ves);
    if (paidMinor > outstandingOf(state)) {
      throw new ApiError('FISCAL_NOTHING_TO_DECLARE',
        'This bill has already been declared in full');
    }

    const { splitMode, share, claimed } = await claimedLines(client, { paymentId, lines });
    const lineBasis = resolveLineBasis({
      splitMode, participantShareMinor: share, paidMinor, claimedItems: claimed
    });

    const sourceLines = lineBasis === 'ITEMISED'
      ? claimed
      : lines.map(l => ({ ...l, shareMinor: l.subtotalMinor, fullMinor: l.subtotalMinor }));

    const tableName = await client.query('SELECT name FROM tables WHERE id = $1', [bill.table_id]);
    const draft = buildDraft({
      state, paidMinor, lineBasis, sourceLines, tableName: tableName.rows[0]?.name ?? null
    });

    // La clave con la que se hablará con el proveedor. Se guarda **antes** de
    // la primera llamada: si el proceso muere a mitad, lo que queda es una
    // petición que se puede consultar, no una emisión de la que no hay rastro.
    const idempotencyKey = `${billId}:${paymentId}:${crypto.randomBytes(8).toString('hex')}`;
    /*
     * El índice único es lo que impide un segundo documento del mismo cobro, y
     * hace bien en existir. Lo que no puede es salir en crudo: un 23505 se
     * traduce en 500 INTERNAL_ERROR, y un cliente que sólo ve «error interno»
     * no tiene forma de decirle al comensal lo único que hay que decirle, que
     * es que su factura **ya está pedida**. Medido antes de arreglarlo: pulsar
     * dos veces devolvía 500 las dos veces siguientes.
     *
     * Se comprueba por el choque y no consultando antes a propósito: entre la
     * consulta y la inserción cabe la segunda pulsación, y entonces el 500
     * volvería exactamente igual pero más difícil de reproducir.
     */
    let request;
    try {
      request = (await client.query(
        `INSERT INTO fiscal_invoice_requests
           (restaurant_id, bill_id, payment_id, idempotency_key, status, provider, draft_json)
         VALUES ($1, $2, $3, $4, 'PENDING', $5, $6)
         RETURNING id, idempotency_key`,
        [restaurantId, billId, paymentId, idempotencyKey, provider, JSON.stringify(serialiseDraft(draft))]
      )).rows[0];
    } catch (err) {
      if (err?.code === '23505' && err?.constraint === 'fiscal_requests_payment_idx') {
        throw new ApiError('FISCAL_ALREADY_REQUESTED',
          'This payment already has an invoice request', { paymentId });
      }
      throw err;
    }

    return { request, draft, bill, customer };
  });

  return sendAndRecord({ restaurantId, billId, paymentId, provider, ...prepared });
}

/**
 * Llama al proveedor y guarda lo que resulte.
 *
 * Fuera de la transacción que creó la petición, a propósito: una llamada de red
 * dentro de una transacción mantiene abierta una fila bloqueada durante todo lo
 * que tarde el otro extremo en contestar -- o en no contestar.
 */
async function sendAndRecord({ restaurantId, billId, paymentId, provider, request, draft, bill, customer }) {
  await db.query(
    `UPDATE fiscal_invoice_requests
        SET status = 'SENT', attempts = attempts + 1, last_attempt_at = now()
      WHERE id = $1`, [request.id]
  );

  let result = await providers.issue(provider, {
    idempotencyKey: request.idempotency_key, draft, customer
  });

  if (result.outcome === 'UNCERTAIN') {
    // La regla entera de este módulo, en dos líneas: se pregunta, no se
    // reintenta. Si el proveedor sí había emitido, aquí aparece.
    logger.warn({
      event: 'FISCAL_ISSUE_UNCERTAIN', requestId: request.id, restaurantId, billId
    }, 'Respuesta ambigua del proveedor fiscal: se consulta antes de reintentar');
    result = await providers.lookup(provider, request.idempotency_key);
  }

  if (result.outcome !== 'ISSUED') {
    // UNCERTAIN se queda como UNCERTAIN y va a la cola de una persona. Un
    // rechazo con motivo sí es FAILED, y por tanto reintentable.
    const status = result.outcome === 'UNCERTAIN' ? 'UNCERTAIN' : 'FAILED';
    await db.query(
      `UPDATE fiscal_invoice_requests SET status = $2, last_error_code = $3 WHERE id = $1`,
      [request.id, status, String(result.reason ?? 'UNKNOWN').slice(0, 80)]
    );
    return { status, requestId: request.id, reason: result.reason ?? null };
  }

  return persistIssued({ restaurantId, billId, paymentId, provider, request, draft, bill, customer, result });
}

/** Escribe el documento, sus líneas y su desglose, de una vez y sin volver atrás. */
async function persistIssued({ restaurantId, billId, paymentId, provider, request, draft, bill, customer, result }) {
  return db.withTransaction(async (client) => {
    const invoice = await client.query(
      `INSERT INTO fiscal_invoices
         (restaurant_id, request_id, bill_id, payment_id, document_number, control_number,
          provider, provider_document_id, line_basis, currency, fx_rate_ves_per_unit,
          subtotal_minor, vat_minor, service_minor, total_minor,
          customer_name, customer_tax_id, customer_email, issued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VES',$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [restaurantId, request.id, billId, paymentId,
        result.documentNumber, result.controlNumber, provider, result.providerDocumentId ?? null,
        draft.lineBasis, bill.fx_rate_ves_per_unit,
        draft.subtotalMinor.toString(), draft.vatMinor.toString(),
        draft.serviceMinor.toString(), draft.totalMinor.toString(),
        customer.name ?? null, customer.taxId ?? null, customer.email ?? null,
        result.issuedAt ?? new Date().toISOString()]
    );
    const invoiceId = invoice.rows[0].id;

    for (const line of draft.lines) {
      await client.query(
        `INSERT INTO fiscal_invoice_lines
           (invoice_id, restaurant_id, position, description, quantity_milli,
            unit_price_minor, tax_category, vat_bps, base_minor, vat_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [invoiceId, restaurantId, line.position, line.description,
          line.quantityMilli.toString(), line.unitPriceMinor.toString(),
          line.taxCategory, line.vatBps, line.baseMinor.toString(), line.vatMinor.toString()]
      );
    }

    for (const tax of draft.taxes) {
      await client.query(
        `INSERT INTO fiscal_invoice_taxes
           (invoice_id, restaurant_id, tax_category, vat_bps, base_minor, vat_minor)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, restaurantId, tax.taxCategory, tax.vatBps,
          tax.baseMinor.toString(), tax.vatMinor.toString()]
      );
    }

    await client.query(
      `UPDATE fiscal_invoice_requests SET status = 'ISSUED' WHERE id = $1`, [request.id]
    );

    return { status: 'ISSUED', requestId: request.id, invoice: invoice.rows[0] };
  });
}

/**
 * Reintenta lo que quedó en duda, preguntando primero.
 *
 * Para la cola que mira una persona, y para un trabajo periódico. Nunca vuelve
 * a pedir la emisión de algo en duda sin haber preguntado antes por su clave.
 */
async function resolveUncertain({ restaurantId, requestId }) {
  const { rows } = await db.query(
    `SELECT r.id, r.provider, r.idempotency_key, r.status, r.bill_id, r.payment_id, r.draft_json,
            b.fx_rate_ves_per_unit
       FROM fiscal_invoice_requests r
       JOIN bills b ON b.id = r.bill_id
      WHERE r.id = $1 AND r.restaurant_id = $2`,
    [requestId, restaurantId]
  );
  if (!rows.length) throw new ApiError('FISCAL_REQUEST_NOT_FOUND', 'Request not found');
  const request = rows[0];

  if (request.status !== 'UNCERTAIN') {
    // Nada que resolver. Se contesta el estado en vez de volver a llamar al
    // proveedor por algo que ya es un hecho.
    return { status: request.status, requestId, unchanged: true };
  }

  const result = await providers.lookup(request.provider, request.idempotency_key);

  if (result.outcome === 'UNCERTAIN') {
    // Sigue sin saberse. Se queda en la cola: es el desenlace correcto, no un
    // fallo. Alguien tiene que mirar antes de declarar una venta dos veces.
    return { status: 'UNCERTAIN', requestId, stillUnknown: true };
  }

  if (result.outcome !== 'ISSUED') {
    // No consta emitida, así que reintentar no duplica nada. Pasa a FAILED, que
    // es el estado que el índice único deja volver a intentar.
    await db.query(
      `UPDATE fiscal_invoice_requests SET status = 'FAILED', last_error_code = $2 WHERE id = $1`,
      [requestId, String(result.reason ?? 'NOT_FOUND').slice(0, 80)]
    );
    return { status: 'FAILED', requestId, retryable: true };
  }

  // Sí había emitido. Se registra **el borrador que se mandó**, no uno nuevo:
  // la cuenta ha seguido viva desde entonces y hoy daría otro documento, pero
  // el que existe ahí fuera es el primero.
  if (!request.draft_json) {
    logger.error({
      event: 'FISCAL_RESOLVE_NO_DRAFT', requestId, restaurantId
    }, 'Se emitió una factura de la que no se guardó el borrador');
    throw new ApiError('FISCAL_DRAFT_MISSING',
      'The provider issued this document but the sent draft was not recorded');
  }

  return persistIssued({
    restaurantId, billId: request.bill_id, paymentId: request.payment_id,
    provider: request.provider, request,
    draft: reviveDraft(request.draft_json),
    bill: { fx_rate_ves_per_unit: request.fx_rate_ves_per_unit },
    customer: request.draft_json.customer ?? {},
    result
  });
}

/**
 * El borrador, en algo que JSON pueda guardar.
 *
 * Los importes son BigInt y `JSON.stringify` no sabe convertirlos -- revienta
 * en vez de redondear, por suerte. Se guardan como cadenas, que es como viaja
 * el dinero en toda la API por la misma razón: un número de JavaScript deja de
 * ser exacto antes de lo que parece.
 */
function serialiseDraft(draft) {
  return {
    lineBasis: draft.lineBasis,
    subtotalMinor: draft.subtotalMinor.toString(),
    vatMinor: draft.vatMinor.toString(),
    serviceMinor: draft.serviceMinor.toString(),
    totalMinor: draft.totalMinor.toString(),
    lines: draft.lines.map(l => ({
      ...l,
      quantityMilli: l.quantityMilli.toString(),
      unitPriceMinor: l.unitPriceMinor.toString(),
      baseMinor: l.baseMinor.toString(),
      vatMinor: l.vatMinor.toString()
    })),
    taxes: draft.taxes.map(t => ({
      ...t, baseMinor: t.baseMinor.toString(), vatMinor: t.vatMinor.toString()
    }))
  };
}

/** La vuelta: cadenas a BigInt, para escribirlo tal como se mandó. */
function reviveDraft(stored) {
  return {
    lineBasis: stored.lineBasis,
    subtotalMinor: BigInt(stored.subtotalMinor),
    vatMinor: BigInt(stored.vatMinor),
    serviceMinor: BigInt(stored.serviceMinor),
    totalMinor: BigInt(stored.totalMinor),
    lines: stored.lines.map(l => ({
      ...l,
      quantityMilli: BigInt(l.quantityMilli),
      unitPriceMinor: BigInt(l.unitPriceMinor),
      baseMinor: BigInt(l.baseMinor),
      vatMinor: BigInt(l.vatMinor)
    })),
    taxes: stored.taxes.map(t => ({
      ...t, baseMinor: BigInt(t.baseMinor), vatMinor: BigInt(t.vatMinor)
    }))
  };
}

module.exports = {
  issueForPayment, resolveUncertain, stateForBill, claimedLines, toVes,
  serialiseDraft, reviveDraft
};
