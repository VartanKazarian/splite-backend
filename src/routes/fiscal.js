const express = require('express');

const db = require('../connectors/base');
const dto = require('../dto');
const { ApiError } = require('../errors');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { requirePlan } = require('../middleware/plan');
const { validateQuery, validateParams } = require('../middleware/schemas');
const { fiscalRequestQuerySchema, fiscalIdParamSchema } = require('../middleware/schemas');
const invoicing = require('../services/fiscalInvoicing');

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
      `SELECT ${INVOICE_COLUMNS} FROM fiscal_invoices
        WHERE restaurant_id = $1
        ORDER BY issued_at DESC
        LIMIT $2 OFFSET $3`,
      [req.user.restaurantId, req.query.limit, req.query.offset]
    );
    res.json({ data: rows.map(dto.fiscalInvoice), limit: req.query.limit, offset: req.query.offset });
  } catch (err) { next(err); }
});

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

    const [lines, taxes] = await Promise.all([
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
      )
    ]);

    res.json(dto.fiscalInvoice({ ...rows[0], lines: lines.rows, taxes: taxes.rows }));
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
