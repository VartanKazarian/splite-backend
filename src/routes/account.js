const express = require('express');
const db = require('../connectors/base');
const { authenticateToken, requireRole } = require('../middleware/auth');
const {
  validateBody, validateParams, payoutSchema, paymentProviderParamSchema,
  restaurantProfileSchema, fiscalSeriesSchema, fiscalRifSchema,
  createStaffSchema, updateStaffSchema, resetStaffPasswordSchema, userIdParamSchema,
  createInvitationSchema, invitationIdParamSchema
} = require('../middleware/schemas');
const staff = require('../services/staff');
const invitations = require('../services/staffInvitations');
const providerConfigs = require('../payments/providerConfigs');
const { logAudit, auditContext } = require('../services/audit');
const banks = require('../payments/banks');
const { ApiError } = require('../errors');
const dto = require('../dto');
const guestContacts = require('../services/guestContacts');
const numbering = require('../services/fiscalNumbering');
const issuer = require('../services/fiscalIssuer');
const { formatRif } = require('../utils/rif');

const router = express.Router();
router.use(authenticateToken);

/**
 * The signed-in restaurant's own record: who it is, and what it is paying for.
 *
 * This exists so that `plan_tier` and `trial_ends_at` are read by something.
 * A column nothing consults is a column that quietly stops being true, and a
 * trial nobody can see is a trial that expires without warning.
 *
 * Note what it does *not* do: nothing here refuses service when the trial ends.
 * Which action a lapsed restaurant loses is a pricing decision, and the obvious
 * candidate is the wrong one -- cutting off bills mid-service strands a dining
 * room full of seated customers over an unpaid invoice. Until that decision is
 * made deliberately, the dates are reported and the frontend warns.
 */
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, name, rif, menu_currency, vat_bps, service_charge_bps,
              payout_bank_code, payout_account_number, payout_phone, payout_holder_id,
              plan_tier, trial_ends_at, fiscal_invoice_policy, fiscal_address, contact_email, created_at
         FROM restaurants
        WHERE id = $1`,
      [req.user.restaurantId]
    );
    if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

    res.json(dto.account(rows[0]));
  } catch (err) { next(err); }
});

/**
 * The restaurant's own name.
 *
 * OWNER and MANAGER, the same pair that may set the payee: this is the name a
 * diner reads on their phone the moment they scan the code on the table, above
 * the table number, so it is a shopfront rather than an internal label.
 *
 * It could only be set once, during onboarding, which left whatever was typed
 * that day -- "Splite Demo", or a mistyped name -- in front of every customer
 * with no way to correct it. Nothing else in the record is touched here;
 * currency, charges and the payee each have their own endpoint because each is
 * a different decision with a different blast radius.
 */
router.patch(
  '/',
  requireRole('OWNER', 'MANAGER'),
  validateBody(restaurantProfileSchema),
  async (req, res, next) => {
    try {
      // Cambiar a quién se le factura no es editar un perfil: decide cómo
      // declara el restaurante. Se reserva al dueño, igual que las decisiones
      // de dinero, y queda auditado aparte para que se pueda responder «quién
      // cambió esto y cuándo» sin leer un diff de la fila entera.
      const setsPolicy = req.body.fiscalInvoicePolicy !== undefined;
      if (setsPolicy && req.user.role !== 'OWNER') {
        throw new ApiError('FORBIDDEN_ROLE', 'Only an owner can change the invoicing policy',
          { requiredRoles: ['OWNER'] });
      }

      const { rows } = await db.query(
        `UPDATE restaurants
            SET name = COALESCE($2, name),
                fiscal_invoice_policy = COALESCE($3, fiscal_invoice_policy),
                -- Tres estados y no dos: ausente deja lo que hay, una cadena
                -- con texto lo cambia, y la cadena vacía lo borra. Con
                -- COALESCE a secas no habría forma de quitar una dirección mal
                -- escrita.
                fiscal_address = CASE
                  WHEN $4::TEXT IS NULL THEN fiscal_address
                  WHEN $4 = '' THEN NULL
                  ELSE $4
                END,
                -- Los mismos tres estados, para el correo de respuesta.
                contact_email = CASE
                  WHEN $5::TEXT IS NULL THEN contact_email
                  WHEN $5 = '' THEN NULL
                  ELSE $5
                END,
                updated_at = NOW()
          WHERE id = $1
        RETURNING id, name, rif, menu_currency, vat_bps, service_charge_bps,
                  payout_bank_code, payout_account_number, payout_phone, payout_holder_id,
                  plan_tier, trial_ends_at, fiscal_invoice_policy, fiscal_address, contact_email, created_at`,
        [req.user.restaurantId, req.body.name ?? null, req.body.fiscalInvoicePolicy ?? null,
          req.body.fiscalAddress ?? null, req.body.contactEmail ?? null]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      if (req.body.name !== undefined) {
        await logAudit({
          ...auditContext(req),
          action: 'RESTAURANT_RENAMED',
          resourceType: 'restaurant',
          resourceId: req.user.restaurantId,
          details: { name: rows[0].name }
        });
      }
      if (setsPolicy) {
        await logAudit({
          ...auditContext(req),
          action: 'FISCAL_POLICY_CHANGED',
          resourceType: 'restaurant',
          resourceId: req.user.restaurantId,
          details: { policy: rows[0].fiscal_invoice_policy }
        });
      }

      res.json(dto.account(rows[0]));
    } catch (err) { next(err); }
  }
);

/**
 * La serie fiscal autorizada: el rango y el formato con los que se numera.
 *
 * Endpoint aparte y no un campo más del perfil, porque no es un dato del
 * restaurante sino la transcripción de un documento del SENIAT, con sus propias
 * reglas sobre cuándo se puede tocar. Mezclarlo en `PATCH /` habría significado
 * que renombrar el local y reescribir la serie pasan por el mismo permiso y la
 * misma auditoría, y no son la misma decisión.
 *
 * Se lee con cualquier rol -- el personal puede necesitar comprobar por qué
 * número va -- y sólo lo escribe el dueño, igual que las decisiones de dinero.
 */
router.get('/fiscal-series', async (req, res, next) => {
  try {
    const row = await numbering.readSeries(db, req.user.restaurantId);
    // Nulo y no 404: «este restaurante todavía no la ha configurado» es una
    // respuesta, y es justo la que el panel necesita para pintar el formulario
    // vacío en vez de una pantalla de error.
    res.json({ fiscalSeries: dto.fiscalSeries(row) });
  } catch (err) { next(err); }
});

router.put(
  '/fiscal-series',
  requireRole('OWNER'),
  validateBody(fiscalSeriesSchema),
  async (req, res, next) => {
    try {
      // Dentro de una transacción porque `writeSeries` decide qué se puede
      // cambiar leyendo el contador: entre esa lectura y la escritura no puede
      // colarse una emisión, o se congelarían campos con un documento ya
      // emitido detrás.
      const row = await db.withTransaction(client =>
        numbering.writeSeries(client, req.user.restaurantId, req.body));

      await logAudit({
        ...auditContext(req),
        action: 'FISCAL_SERIES_CHANGED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        // La referencia de la autorización y el rango, que es lo que hay que
        // poder responder después: con qué papel se emitió y desde qué número.
        details: {
          authorisationRef: row.authorisation_ref,
          controlFirst: String(row.control_first),
          controlLast: row.control_last === null ? null : String(row.control_last)
        }
      });

      res.json({ fiscalSeries: dto.fiscalSeries(row) });
    } catch (err) { next(err); }
  }
);

/**
 * El RIF con el que este restaurante declara.
 *
 * Endpoint aparte y no un campo de `PATCH /`, por lo mismo que la serie: el
 * nombre del local es un dato del perfil y el RIF es la identidad fiscal, con
 * otro permiso, otra auditoría y una regla propia sobre cuándo deja de poder
 * tocarse. Que un gerente pueda renombrar el sitio no significa que pueda
 * cambiar de contribuyente.
 *
 * No hay GET: el RIF ya viaja en `GET /account`, y publicarlo dos veces sería
 * dar dos respuestas a la misma pregunta.
 */
router.put(
  '/rif',
  requireRole('OWNER'),
  validateBody(fiscalRifSchema),
  async (req, res, next) => {
    try {
      // En transacción por la misma razón que la serie: `writeRif` decide si
      // puede cambiar mirando si ya hay documentos emitidos, y entre esa
      // lectura y la escritura no puede colarse una emisión.
      const result = await db.withTransaction(client =>
        issuer.writeRif(client, req.user.restaurantId, req.body.rif));

      if (result.changed) {
        await logAudit({
          ...auditContext(req),
          action: 'FISCAL_RIF_CHANGED',
          resourceType: 'restaurant',
          resourceId: req.user.restaurantId,
          // El anterior también, que es lo que hay que poder responder luego:
          // con qué identidad se estuvo operando y desde cuándo.
          details: { rif: result.rif, previous: result.previous ?? null }
        });
      }

      // `checksumOk` en falso no impidió guardar, así que la pantalla es quien
      // tiene que decirlo. Ver `fiscalIssuer` para por qué no se rechaza.
      res.json({ rif: formatRif(result.rif), checksumOk: result.checksumOk });
    } catch (err) { next(err); }
  }
);

/**
 * Los comensales que quisieron saber del restaurante.
 *
 * No es «la gente que ha pagado aquí»: es sólo quien marcó una casilla vacía
 * diciendo que sí, y no se ha dado de baja. La diferencia es el producto
 * entero -- una lista de gente que aceptó vale para algo, y una lista de gente
 * que sólo quería su factura es un problema esperando.
 *
 * Por eso no hay parámetro para ver «todos los correos». Existiría para ser
 * usado, y lo único que se puede hacer con los demás correos es mandarles algo
 * que no pidieron.
 */
router.get('/contacts', requireRole('OWNER', 'MANAGER'), async (req, res, next) => {
  try {
    const rows = await guestContacts.listConsented({
      restaurantId: req.user.restaurantId,
      limit: Number(req.query.limit) > 0 ? Math.min(Number(req.query.limit), 200) : 100,
      offset: Number(req.query.offset) > 0 ? Number(req.query.offset) : 0
    });
    res.json({
      data: rows.map(row => ({
        id: row.id,
        email: row.email,
        name: row.name ?? null,
        consentAt: row.consent_at ? new Date(row.consent_at).toISOString() : null
      }))
    });
  } catch (err) { next(err); }
});

/**
 * The banks a payee can be configured against.
 *
 * `chargeable` is the honest half: a restaurant may name any bank, because that
 * is where diners send money whether or not we have an integration, but only a
 * bank with a module can take part in an in-app payment. Nothing is chargeable
 * yet, and the field says so rather than the frontend assuming.
 */
router.get('/banks', (req, res) => {
  res.json({ data: banks.list() });
});

/**
 * Where the restaurant is paid.
 *
 * OWNER and MANAGER only. This is the address money is sent to: getting it
 * wrong does not degrade the product, it pays a stranger, and that is not a
 * change a waiter should be able to make from the floor.
 *
 * Sending `{}` clears it -- the schema requires all four fields together or
 * none, matching the database, because a half-filled payee looks configured on
 * screen and cannot receive money.
 */
router.put(
  '/payout',
  requireRole('OWNER', 'MANAGER'),
  validateBody(payoutSchema),
  async (req, res, next) => {
    try {
      const { bankCode, accountNumber, phone, holderId } = req.body;
      // Digits only, so the same number typed three ways is one value and can
      // be compared against what a bank reports.
      const normalisedPhone = phone ? String(phone).replace(/\D/g, '') : null;

      const { rows } = await db.query(
        `UPDATE restaurants
            SET payout_bank_code = $2, payout_account_number = $3,
                payout_phone = $4, payout_holder_id = $5, updated_at = NOW()
          WHERE id = $1
        RETURNING id, name, rif, menu_currency, vat_bps, service_charge_bps,
                  payout_bank_code, payout_account_number, payout_phone, payout_holder_id,
                  plan_tier, trial_ends_at, fiscal_invoice_policy, fiscal_address, contact_email, created_at`,
        [req.user.restaurantId, bankCode ?? null, accountNumber ?? null,
         normalisedPhone, holderId ?? null]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      await logAudit({
        ...auditContext(req),
        action: bankCode ? 'PAYOUT_DETAILS_UPDATED' : 'PAYOUT_DETAILS_CLEARED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        // The bank and the holder, never the account number: an audit log is
        // read by more people, and kept longer, than the row it describes.
        details: { bankCode: bankCode ?? null, holderId: holderId ?? null }
      });

      res.json(dto.account(rows[0]));
    } catch (err) { next(err); }
  }
);

/**
 * Bank API credentials.
 *
 * OWNER only, unlike the payee details, which MANAGER can also set. The payee
 * says where money should be sent; these let software move it. That is a
 * different kind of authority and it belongs with whoever owns the business.
 *
 * Nothing here ever returns a credential. There is no read endpoint, and the
 * DTO has no field that could carry one -- not even a masked tail, which is a
 * leak with a decoration on it.
 */
router.get('/payment-providers', async (req, res, next) => {
  try {
    const rows = await providerConfigs.listConfigs(req.user.restaurantId);
    res.json({
      data: rows.map(dto.paymentProviderConfig),
      supported: providerConfigs.PROVIDERS
    });
  } catch (err) { next(err); }
});

router.put(
  '/payment-providers/:provider',
  requireRole('OWNER'),
  validateParams(paymentProviderParamSchema),
  async (req, res, next) => {
    try {
      const provider = req.params.provider.toUpperCase();
      const config = await providerConfigs.putCredentials({
        restaurantId: req.user.restaurantId,
        provider,
        credentials: req.body
      });

      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_CREDENTIALS_STORED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        // The provider and nothing else. Audit rows outlive the credentials
        // they describe and are read by more people.
        details: { provider }
      });

      res.json(dto.paymentProviderConfig(config));
    } catch (err) { next(err); }
  }
);

router.delete(
  '/payment-providers/:provider',
  requireRole('OWNER'),
  validateParams(paymentProviderParamSchema),
  async (req, res, next) => {
    try {
      const provider = req.params.provider.toUpperCase();
      await providerConfigs.deleteConfig({ restaurantId: req.user.restaurantId, provider });
      await logAudit({
        ...auditContext(req),
        action: 'PAYMENT_CREDENTIALS_DELETED',
        resourceType: 'restaurant',
        resourceId: req.user.restaurantId,
        details: { provider }
      });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

/**
 * The people who work here.
 *
 * Under /account rather than a top-level /users because that is what it is: the
 * signed-in restaurant's own staff. There is no cross-tenant surface to build
 * later, and a top-level noun invites one.
 *
 * OWNER and MANAGER only. The service enforces which of the two may do what to
 * whom -- rank, never yourself, and the last active owner stays -- because a
 * rule enforced in a router is a rule enforced on the paths somebody remembered.
 */
const managesStaff = requireRole('OWNER', 'MANAGER');

router.get('/users', managesStaff, async (req, res, next) => {
  try {
    const rows = await staff.listStaff({ restaurantId: req.user.restaurantId });
    res.json({ data: rows.map(dto.staffMember) });
  } catch (err) { next(err); }
});

router.post('/users', managesStaff, validateBody(createStaffSchema), async (req, res, next) => {
  try {
    const created = await staff.createStaff({
      restaurantId: req.user.restaurantId,
      actor: { id: req.user.sub, role: req.user.role },
      email: req.body.email,
      password: req.body.password,
      role: req.body.role,
      meta: auditContext(req)
    });
    res.status(201).json({ user: dto.staffMember(created) });
  } catch (err) { next(err); }
});

/**
 * Changes a role, a standing, or both.
 *
 * `sessionsRevoked` is reported rather than kept private: somebody removing a
 * person after an argument wants to know the refresh tokens are dead, and the
 * number is also the honest way to say that the access token they are holding
 * is not -- it keeps working until it expires.
 */
router.patch(
  '/users/:userId',
  managesStaff,
  validateParams(userIdParamSchema),
  validateBody(updateStaffSchema),
  async (req, res, next) => {
    try {
      const { user, sessionsRevoked } = await staff.updateStaff({
        restaurantId: req.user.restaurantId,
        actor: { id: req.user.sub, role: req.user.role },
        userId: req.params.userId,
        role: req.body.role,
        active: req.body.active,
        meta: auditContext(req)
      });
      res.json({ user: dto.staffMember(user), sessionsRevoked });
    } catch (err) { next(err); }
  }
);

/**
 * Sets somebody else's password, which is also how a forgotten one is
 * recovered: there is no self-service change yet.
 */
router.post(
  '/users/:userId/password',
  managesStaff,
  validateParams(userIdParamSchema),
  validateBody(resetStaffPasswordSchema),
  async (req, res, next) => {
    try {
      const { sessionsRevoked } = await staff.resetStaffPassword({
        restaurantId: req.user.restaurantId,
        actor: { id: req.user.sub, role: req.user.role },
        userId: req.params.userId,
        password: req.body.password,
        meta: auditContext(req)
      });
      res.json({ sessionsRevoked });
    } catch (err) { next(err); }
  }
);

/**
 * Invitaciones al equipo. Ver `services/staffInvitations.js`.
 *
 * El enlace sale en la respuesta de crear, y sólo ahí: es lo que quien invita
 * comparte por WhatsApp si el correo no está configurado o no llega. No se
 * puede volver a pedir; se reenvía, y el anterior queda anulado.
 */
router.get('/invitations', managesStaff, async (req, res, next) => {
  try {
    const rows = await invitations.listInvitations({ restaurantId: req.user.restaurantId });
    res.json({ data: rows.map(dto.staffInvitation) });
  } catch (err) { next(err); }
});

router.post('/invitations', managesStaff, validateBody(createInvitationSchema), async (req, res, next) => {
  try {
    const { invitation, link, emailed } = await invitations.createInvitation({
      restaurantId: req.user.restaurantId,
      actor: { id: req.user.sub, role: req.user.role },
      email: req.body.email,
      role: req.body.role,
      meta: auditContext(req)
    });
    // Que ningún intermediario guarde una respuesta con una llave dentro.
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ invitation: dto.staffInvitation(invitation), link, emailed });
  } catch (err) { next(err); }
});

router.delete(
  '/invitations/:invitationId',
  managesStaff,
  validateParams(invitationIdParamSchema),
  async (req, res, next) => {
    try {
      await invitations.revokeInvitation({
        restaurantId: req.user.restaurantId,
        actor: { id: req.user.sub, role: req.user.role },
        invitationId: req.params.invitationId,
        meta: auditContext(req)
      });
      res.status(204).end();
    } catch (err) { next(err); }
  }
);

module.exports = router;
