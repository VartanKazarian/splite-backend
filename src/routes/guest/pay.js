/** Paying: the hold that tells the table someone is paying, the Pago Movil notice, C2P, and the contact and invoice details that go with it. */
const express = require('express');
const {
  validateBody,
  validateQuery,
  declareClaimSchema,
  paymentHoldSchema,
  c2pChargeSchema,
  c2pBankGuideQuerySchema,
  requestInvoiceSchema,
  guestContactSchema
} = require('../../middleware/schemas');
const { authenticateGuest } = require('../../services/guest');
const rateLimit = require('../../middleware/rateLimit');
const paymentClaims = require('../../services/paymentClaims');
const paymentHolds = require('../../services/paymentHolds');
const mercantilC2P = require('../../services/mercantilC2P');
const claveGuide = require('../../payments/c2pClaveGuide');
const banks = require('../../payments/banks');
const { requestHash, begin, complete, abort } = require('../../services/idempotency');
const { logger } = require('../../connectors/logger');
const dto = require('../../dto');
const { logAudit, auditContext } = require('../../services/audit');
const { ApiError } = require('../../errors');
const invoicing = require('../../services/fiscalInvoicing');
const guestContacts = require('../../services/guestContacts');
const { assertPlanAllows } = require('../../middleware/plan');
const { perSession, openBillForGuest, billForGuestPayment } = require('./shared');

const router = express.Router();

/**
 * «Voy a pagar esto»: aparta lo que el comensal está por transferir.
 *
 * La pantalla lo pide al abrir el pago, antes de que el comensal copie los
 * datos y vaya a su banco. Mientras dura, el resto de la mesa ve esa parte
 * como «alguien está pagando» y no puede reservarla. 409 PAYMENT_HELD con lo
 * que queda libre si otro llegó antes. Volver a pedirla cambia la propia.
 */
router.post('/bill/holds', authenticateGuest, perSession, validateBody(paymentHoldSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const hold = await paymentHolds.placeHold({
      restaurantId: req.guest.restaurantId,
      billId: bill.id,
      sessionId: req.guest.sessionId,
      amountVes: req.body.amountVes,
      splitParticipantId: req.body.splitParticipantId ?? null
    });
    res.status(201).json(dto.paymentHold(hold));
  } catch (err) { next(err); }
});

/** El comensal volvió atrás: la parte queda libre para los demás. Idempotente. */
router.delete('/bill/holds', authenticateGuest, perSession, async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    await paymentHolds.releaseHold({
      restaurantId: req.guest.restaurantId, billId: bill.id, sessionId: req.guest.sessionId
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

router.post('/bill/payment-claims', authenticateGuest, perSession, validateBody(declareClaimSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const claim = await paymentClaims.declareClaim({
      restaurantId: req.guest.restaurantId,
      billId: bill.id,
      amountVes: req.body.amountVes,
      reference: req.body.reference,
      phoneOrigin: req.body.phoneOrigin,
      bankOrigin: req.body.bankOrigin,
      idOrigin: req.body.idOrigin,
      payer: { type: 'GUEST', id: null },
      guestSessionId: req.guest.sessionId,
      splitParticipantId: req.body.splitParticipantId ?? null,
      tipVes: req.body.tipVes ?? '0',
      // Se guarda aunque aquí no se pueda facturar: rechazar el aviso de un
      // pago ya enviado por un campo opcional sería impedirle avisar. Si al
      // confirmar no se puede emitir, la petición queda como FAILED con su
      // motivo, y la pantalla ni siquiera ofrece la casilla en ese caso.
      invoice: req.body.invoice ?? null,
      meta: { ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id }
    });

    res.status(201).json(dto.paymentClaim(claim));
  } catch (err) { next(err); }
});

/**
 * How to obtain a C2P clave, for every bank Splite can charge.
 *
 * The step of the C2P flow Splite does not control: the diner asks their own
 * bank for a single-use clave. This is static reference data -- channels, SMS
 * short codes and bodies, and how long the clave lives -- so the app can show
 * the exact instruction for the chosen bank instead of a generic prompt that
 * strands a Banplus customer hunting an SMS code that does not exist.
 *
 * The `strategy` on each bank is the part that matters: a clave that lasts five
 * minutes, or one bound to the amount, must be fetched at payment time, not
 * when the diner sits down. Optional `idType`/`idNumber` fill the diner's own
 * identity into the SMS bodies that take it.
 *
 * Guest-session gated for consistency with the rest of this surface; the data
 * itself is public and per-bank, never per-diner.
 */
/**
 * El correo del comensal, y qué se puede hacer con él.
 *
 * Se pide con una excusa concreta -- que le llegue su factura -- y el
 * restaurante querría además mandarle promociones. **Son dos finalidades**, y
 * este endpoint las guarda como dos cosas: `marketingConsent` sólo llega a
 * `true` si quien está delante marcó una casilla que estaba vacía.
 *
 * Omitir el campo no consiente ni retira nada. Para darse de baja está el
 * borrado explícito, y una baja previa no se reactiva por volver a dejar el
 * correo: alguien que se dio de baja y vuelve a cenar sigue de baja, porque no
 * ha vuelto a decir que sí.
 *
 * Sin puerta de plan: dejar tu correo no es una capacidad que se venda, y el
 * comensal no tiene por qué enterarse de lo que su restaurante tiene
 * contratado.
 */
router.post(
  '/bill/contact',
  authenticateGuest,
  perSession,
  validateBody(guestContactSchema),
  async (req, res, next) => {
    try {
      const bill = await openBillForGuest(req.guest).catch(() => null);
      const contact = await guestContacts.upsert({
        restaurantId: req.guest.restaurantId,
        billId: bill?.id ?? null,
        email: req.body.email,
        name: req.body.name ?? null,
        marketingConsent: req.body.marketingConsent === true,
        source: 'GUEST_CHECKOUT'
      });

      res.status(201).json({
        email: contact.email,
        // Se devuelve lo que quedó guardado y no lo que se pidió: si había una
        // baja previa, el comensal tiene derecho a ver que sigue de baja en vez
        // de creer que acaba de apuntarse.
        marketingConsent: contact.marketing_consent,
        withdrawn: contact.withdrawn_at !== null
      });
    } catch (err) { next(err); }
  }
);

/**
 * «¿Necesitas factura?», después de pagar.
 *
 * El sitio importa: va al final, junto al recibo, cuando el dinero ya se movió.
 * Un formulario fiscal antes de pagar convierte una cena en un trámite, y la
 * mayoría de la gente no lo necesita.
 *
 * **Consumidor final es el camino principal, no la excepción.** Los tres datos
 * del receptor son opcionales y un cuerpo con sólo `paymentId` es una petición
 * completa: la mayoría no va a dar su cédula. Quien sí la da suele necesitarla
 * exacta -- va a justificar el gasto -- y por eso el RIF se valida en vez de
 * aceptarse como texto libre.
 *
 * El comensal sólo puede facturar un cobro de **su propia mesa**: el `billId`
 * sale de la sesión que firmó el QR y no del cuerpo, así que no hay campo en el
 * que nombrar la cuenta de otro. Es la misma regla que ya gobierna el resto de
 * esta superficie.
 *
 * Un fallo aquí **nunca** significa que el pago fallara. El dinero ya está
 * cobrado y el recibo ya es válido; lo que puede quedar pendiente es el
 * documento fiscal, y el cliente tiene que contarlo así.
 */
router.post(
  '/bill/invoice',
  authenticateGuest,
  perSession,
  validateBody(requestInvoiceSchema),
  async (req, res, next) => {
    try {
      await assertPlanAllows(req.guest.restaurantId, 'fiscalInvoicing');

      // El mismo cálculo que `canIssue` publica en la cuenta. Uno solo, para
      // que lo que se promete y lo que se acepta no puedan discrepar.
      const provider = invoicing.activeProvider();
      if (!provider) {
        // Sin imprenta configurada no hay forma de emitir nada válido. Se dice,
        // en vez de fallar de una manera que parezca culpa del comensal.
        throw new ApiError('FISCAL_PROVIDER_NOT_CONFIGURED',
          'This deployment has no fiscal provider configured');
      }

      // Desde el pago y no desde la cuenta abierta. Confirmar el cobro cierra
      // la cuenta, así que pedir aquí `openBillForGuest` hacía imposible
      // facturar justo cuando ya se podía.
      const found = await billForGuestPayment(req.guest, req.body.paymentId);
      const result = await invoicing.issueForPayment({
        restaurantId: req.guest.restaurantId,
        billId: found.bill_id,
        paymentId: req.body.paymentId,
        provider,
        customer: {
          name: req.body.name ?? null,
          taxId: req.body.taxId ?? null,
          email: req.body.email ?? null
        }
      });

      // 202 y no 201 cuando queda en duda: no se ha creado ningún documento
      // todavía, y puede que nunca se cree. Decir 201 sería prometer una
      // factura que quizá no exista.
      const created = result.status === 'ISSUED';
      res.status(created ? 201 : 202).json({
        status: result.status,
        requestId: result.requestId,
        invoice: result.invoice ? dto.fiscalInvoice(result.invoice) : null,
        // Lo que el comensal necesita saber, y que no es el estado interno.
        paymentUnaffected: true
      });
    } catch (err) { next(err); }
  }
);

/**
 * Los bancos, para que el comensal elija el suyo en vez de escribirlo.
 *
 * `bankOrigin` es opcional y corrobora un Pago Móvil declarado, pero el
 * servidor sólo acepta un código de cuatro dígitos de la lista conocida -- por
 * la razón que dice `declareClaimSchema`: "Banesco", "banesco" y "BANESCO 0134"
 * son un banco que se compara como tres, y quien paga la diferencia es quien
 * verifica leyendo una pantalla.
 *
 * El campo del comensal era texto libre, así que escribir el nombre del banco
 * -- lo natural -- devolvía 400 y **le impedía pagar**, por un campo opcional.
 * El propio mensaje de error decía «elígelo de la lista» y esa lista no existía
 * en ninguna parte a la que el comensal llegara: `banks.list()` ya estaba
 * escrito "for a picker", y `/account/banks` lo sirve sólo al personal.
 *
 * Es la misma lista pública de siempre, sin nada del restaurante ni de la mesa.
 * Va detrás de la sesión igual que el resto de esta superficie, por coherencia
 * y porque quien la pide ya escaneó.
 */
router.get('/banks', authenticateGuest, perSession, (req, res) => {
  res.json({ data: banks.list() });
});

router.get('/c2p/banks', authenticateGuest, perSession, validateQuery(c2pBankGuideQuerySchema), (req, res) => {
  const identity = { idType: req.query.idType, idNumber: req.query.idNumber };
  const data = claveGuide.supportedC2PBanks()
    .map(bank => claveGuide.claveInstructions(bank.code, identity))
    .filter(Boolean);
  res.json({ data });
});

/**
 * Charge the diner's own bank account (Mercantil C2P).
 *
 * Unlike `payment-claims`, this one moves money. The diner supplies a
 * single-use clave they obtained from their own bank and Splite asks Mercantil
 * to pull the amount, so the response is an outcome rather than a message to
 * staff.
 *
 * Four outcomes, and the client must handle all four:
 *
 *   SUCCEEDED  settled; `settlement` carries the new bill figures.
 *   FAILED     the bank said no. Safe to try again with a fresh clave.
 *   IN_DOUBT   the bank did not say. **Do not offer a retry** -- the debit may
 *              have landed. Staff resolve it from the dashboard.
 *   AMBIGUOUS  the debit is confirmed and could not be credited to the bill.
 *              Needs a person, and possibly a refund.
 *
 * `Idempotency-Key` is mandatory, and its stored response is what makes a lost
 * connection safe: a client that never saw the answer replays the original
 * outcome instead of raising a second charge.
 */
router.post(
  '/bill/c2p',
  authenticateGuest,
  perSession,
  // Far tighter than the general guest limit, and not about server load. Each
  // attempt burns a single-use clave the diner had to fetch from their bank,
  // and each one consumes the restaurant's C2P quota with Mercantil. Eight in
  // five minutes is well past honest retrying and well short of useful abuse.
  rateLimit({ windowSeconds: 300, max: 8, keyPrefix: 'guest:c2p' }),
  validateBody(c2pChargeSchema),
  async (req, res, next) => {
    const restaurantId = req.guest.restaurantId;
    const key = req.get('Idempotency-Key') || req.body.idempotencyKey;
    let claimed = false;

    try {
      const idem = await begin({ restaurantId, userId: null, key, hash: requestHash(req) });
      if (!idem.owner) return res.status(idem.response.status).json(idem.response.body);
      claimed = true;

      const bill = await openBillForGuest(req.guest);
      const result = await mercantilC2P.createC2PPayment({
        restaurantId,
        billId: bill.id,
        amountVes: req.body.amountVes,
        payer: {
          bankCode: req.body.bankCode,
          idNumber: req.body.idNumber,
          phone: req.body.phone,
          clave: req.body.clave
        },
        idempotencyKey: key,
        splitParticipantId: req.body.splitParticipantId ?? null,
        tipVes: req.body.tipVes ?? '0'
      });

      // Stored before replying, so a retry that races the response replays the
      // outcome rather than charging again. This is the line that makes an
      // IN_DOUBT charge safe to sit on: the retry cannot reach the bank.
      await complete({ restaurantId, key, status: 201, body: result });

      await logAudit({
        ...auditContext(req),
        restaurantId,
        action: 'C2P_CHARGE_RAISED',
        resourceType: 'payment',
        resourceId: result.paymentId,
        details: { billId: bill.id, status: result.status }
      });

      res.status(201).json(result);
    } catch (err) {
      // Only reached before the bank was asked, or when the charge was
      // rejected outright -- createC2PPayment converts every post-debit failure
      // into a returned outcome precisely so this branch cannot release a key
      // that a real debit is sitting behind.
      if (claimed) {
        try { await abort({ restaurantId, key }); } catch (abortErr) {
          logger.error({ event: 'IDEMPOTENCY_ABORT_FAILED', err: abortErr }, 'Idempotency abort failed');
        }
      }
      next(err);
    }
  }
);

module.exports = router;
