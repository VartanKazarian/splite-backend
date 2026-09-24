const express = require('express');

const db = require('../connectors/base');
const dto = require('../dto');
const { ApiError } = require('../errors');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePlan } = require('../middleware/plan');
const { validateQuery, validateParams } = require('../middleware/schemas');
const { fiscalRequestQuerySchema, fiscalIdParamSchema, fiscalExportQuerySchema } = require('../middleware/schemas');
const invoicing = require('../services/fiscalInvoicing');
const fiscalMail = require('../services/fiscalMail');
const fiscalPdf = require('../services/fiscalPdf');
const fiscalExport = require('../services/fiscalExport');

/**
 * Las facturas fiscales, para el restaurante.
 *
 * La división que gobierna este fichero: **se cierra emitir, nunca consultar.**
 *
 * Emitir es una capacidad del plan. Leer un documento ya emitido no lo es y no
 * puede serlo: el deber legal de conservarlo es del restaurante y sobrevive a
 * la suscripción. Una factura que dejara de poder leerse porque una factura
 * quedó sin pagar sería un problema creado por Splite. Por eso `requirePlan` no
 * aparece en ninguna de las lecturas de aquí, y eso es deliberado.
 */
const router = express.Router();
router.use(authenticateToken);

const INVOICE_COLUMNS = `id, bill_id, payment_id, document_type, compensates_id,
                         document_number, control_number, provider, line_basis,
                         currency, subtotal_minor, vat_minor, service_minor, total_minor,
                         customer_name, customer_tax_id, customer_email, issued_at`;

/**
 * Las facturas emitidas, las más recientes primero.
 *
 * Sin puerta de plan: ver el comentario de arriba.
 */
router.get('/invoices', validateQuery(fiscalRequestQuerySchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      // Con la mesa: en la lista, un número de factura solo no dice a qué
      // cobro corresponde, y es lo que el restaurante busca («la de la 12»).
      `SELECT ${INVOICE_COLUMNS.split(',').map(c => `fi.${c.trim()}`).join(', ')},
              t.name AS table_name
         FROM fiscal_invoices fi
         LEFT JOIN bills b ON b.id = fi.bill_id AND b.restaurant_id = fi.restaurant_id
         LEFT JOIN tables t ON t.id = b.table_id AND t.restaurant_id = fi.restaurant_id
        WHERE fi.restaurant_id = $1
        ORDER BY fi.issued_at DESC
        LIMIT $2 OFFSET $3`,
      [req.user.restaurantId, req.query.limit, req.query.offset]
    );
    res.json({ data: rows.map(dto.fiscalInvoice), limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

/**
 * Las facturas de un mes, en CSV, para el contador.
 *
 * Antes de `/invoices/:id`, que si no leería «export» como un id. Sin puerta de
 * plan, como toda lectura; pero sólo dueño y encargado: es la lista entera de
 * clientes con su RIF o cédula de golpe, que no es lo mismo que abrir una
 * factura suelta. Ver `services/fiscalExport.js` para lo que el fichero es y
 * lo que no.
 */
router.get(
  '/invoices/export',
  requireRole('OWNER', 'MANAGER'),
  validateQuery(fiscalExportQuerySchema),
  async (req, res, next) => {
    try {
      const docs = await fiscalExport.load({ restaurantId: req.user.restaurantId, month: req.query.month });
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fiscalExport.filenameFor(req.query.month)}"`,
        'Cache-Control': 'private, no-store'
      });
      res.send(fiscalExport.buildCsv(docs));
    } catch (err) { next(err); }
  }
);

/**
 * Una factura con sus líneas y su desglose por alícuota.
 *
 * El desglose va aparte de las líneas y no se deduce de ellas: es lo que el
 * documento declara, y con `line_basis = AGGREGATE` hay una sola línea y aun
 * así hay que separar el 16% del exento.
 */
router.get('/invoices/:id', validateParams(fiscalIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ${INVOICE_COLUMNS} FROM fiscal_invoices WHERE id = $1 AND restaurant_id = $2`,
      [req.params.id, req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('NOT_FOUND', 'Invoice not found');

    const [lines, taxes, delivery] = await Promise.all([
      db.query(
        `SELECT position, description, quantity_milli, unit_price_minor,
                tax_category, vat_bps, base_minor, vat_minor
           FROM fiscal_invoice_lines WHERE invoice_id = $1 ORDER BY position`,
        [req.params.id]
      ),
      db.query(
        `SELECT tax_category, vat_bps, base_minor, vat_minor
           FROM fiscal_invoice_taxes WHERE invoice_id = $1 ORDER BY vat_bps`,
        [req.params.id]
      ),
      // El envío por correo, si lo hubo. La pregunta que se le hace a esta
      // pantalla cuando alguien llama diciendo que no le llegó su factura.
      db.query(
        `SELECT email, status, attempts, sent_at, last_error
           FROM fiscal_invoice_deliveries WHERE invoice_id = $1
          ORDER BY created_at DESC LIMIT 1`,
        [req.params.id]
      )
    ]);

    res.json(dto.fiscalInvoice({
      ...rows[0], lines: lines.rows, taxes: taxes.rows, delivery: delivery.rows[0] ?? null
    }));
  } catch (err) { next(err); }
});

/**
 * La misma factura, en PDF, para guardarla o imprimirla.
 *
 * Sin puerta de plan, como el resto de lecturas: conservar las facturas es un
 * deber del restaurante que sobrevive a la suscripción.
 *
 * El restaurante se comprueba aquí, antes de cargar nada: `fiscalMail.load`
 * busca por id sin mirar de quién es, y sin esta consulta un UUID ajeno
 * devolvería la factura de otro local.
 */
router.get('/invoices/:id/pdf', validateParams(fiscalIdParamSchema), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id FROM fiscal_invoices WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('NOT_FOUND', 'Invoice not found');

    const data = await fiscalMail.load(req.params.id);
    const pdf = await fiscalPdf.render(data);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${fiscalPdf.filenameFor(data.invoice)}"`,
      // Un documento fiscal no debe quedarse en la caché de un proxy ni de un
      // navegador compartido.
      'Cache-Control': 'private, no-store'
    });
    res.send(pdf);
  } catch (err) { next(err); }
});

/**
 * Los intentos de emisión, para la cola que mira una persona.
 *
 * `?status=UNCERTAIN` es la consulta que importa: son los casos en que el
 * proveedor contestó algo que no dice si emitió. Salen los más viejos primero,
 * al revés que las facturas, porque una duda de ayer es más urgente que una de
 * hace un minuto.
 */
router.get('/requests', validateQuery(fiscalRequestQuerySchema), async (req, res, next) => {
  try {
    const params = [req.user.restaurantId];
    let where = 'r.restaurant_id = $1';
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND r.status = $${params.length}`;
    }
    params.push(req.query.limit, req.query.offset);

    const { rows } = await db.query(
      `SELECT r.id, r.bill_id, r.payment_id, r.document_type, r.status, r.provider,
              r.attempts, r.last_error_code, r.last_attempt_at, r.created_at,
              i.id AS invoice_id
         FROM fiscal_invoice_requests r
         LEFT JOIN fiscal_invoices i ON i.request_id = r.id
        WHERE ${where}
        ORDER BY r.created_at ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows.map(dto.fiscalRequest), limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

/**
 * Preguntarle al proveedor qué pasó con un intento en duda.
 *
 * Nunca vuelve a pedir la emisión: consulta por la clave de idempotencia. Es la
 * única acción segura sobre algo que quizá ya se emitió, y por eso la ruta se
 * llama «resolver» y no «reintentar».
 *
 * Con puerta de plan, porque puede acabar registrando un documento -- y un
 * restaurante que ya no tiene la facturación contratada no debe seguir
 * emitiendo. Consultar el resultado, en cambio, sigue abierto arriba.
 */
router.post(
  '/requests/:id/resolve',
  requireRole('OWNER', 'MANAGER'),
  requirePlan('fiscalInvoicing'),
  validateParams(fiscalIdParamSchema),
  async (req, res, next) => {
    try {
      const result = await invoicing.resolveUncertain({
        restaurantId: req.user.restaurantId, requestId: req.params.id
      });
      res.json({
        requestId: result.requestId,
        status: result.status,
        // Distingue «sigue sin saberse» de «ya estaba resuelto», que para quien
        // mira la cola son cosas muy distintas.
        stillUnknown: result.stillUnknown ?? false,
        unchanged: result.unchanged ?? false,
        invoice: result.invoice ? dto.fiscalInvoice(result.invoice) : null
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
