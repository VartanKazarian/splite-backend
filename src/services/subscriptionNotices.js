const config = require('../config');
const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');
const { logAudit } = require('./audit');
const fx = require('./fx');
const mailer = require('./mailer');
const money = require('./money');
const operators = require('./operators');
const billing = require('./platformBilling');
const settings = require('./platformSettings');

/**
 * Lo que ve y hace un restaurante con su suscripción, y los avisos de «Ya pagué».
 *
 * El restaurante paga a Splite como sus comensales le pagan a él: por Pago
 * Móvil o transferencia, y avisa. El aviso no mueve nada: alguien de Splite lo
 * busca en su banco y lo confirma -- y entonces sí se registra el pago -- o lo
 * rechaza con un motivo que el restaurante ve.
 */

const iso = v => (v ? new Date(v).toISOString() : null);

function noticeView(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name ?? undefined,
    chargeId: row.charge_id,
    chargePeriodStart: row.charge_period_start ? billing._internals.day(row.charge_period_start) : null,
    method: row.method,
    currency: row.currency,
    amount: String(row.amount),
    reference: row.reference,
    paidOn: billing._internals.day(row.paid_on),
    notes: row.notes ?? null,
    status: row.status,
    rejectReason: row.reject_reason ?? null,
    submittedBy: row.submitted_by_email ?? null,
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at)
  };
}

const NOTICE_SQL = `
  SELECT n.*, r.name AS restaurant_name, c.period_start AS charge_period_start, u.email AS submitted_by_email
    FROM subscription_payment_notices n
    JOIN restaurants r ON r.id = n.restaurant_id
    LEFT JOIN subscription_charges c ON c.id = n.charge_id
    LEFT JOIN users u ON u.id = n.submitted_by`;

/** El dólar del BCV de hoy, para enseñar en bolívares lo que se debe. Null si no hay. */
async function usdRate() {
  const r = await fx.getRateFor('USD').catch(() => null);
  return r ? { rate: String(r.rate), valueDate: r.valueDate ?? null } : null;
}

function toVes(usdMinor, rate) {
  if (!rate) return null;
  return String(money.applyRate(usdMinor, money.parseRate(rate.rate)));
}

/**
 * «Tu suscripción», como la ve el dueño. Sin las notas internas de Splite ni
 * nada de la consola: plan, precio, lo que debe, a dónde pagar y sus avisos.
 */
async function forRestaurant(restaurantId) {
  const today = fx.caracasToday();
  const { rows } = await db.query(`${billing.CLIENT_SQL} WHERE r.id = $2`, [today, restaurantId]);
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
  const c = billing.clientView(rows[0], today);

  const [charges, notices, details, rate] = await Promise.all([
    db.query(
      `SELECT c.*, (SELECT COALESCE(SUM(p.applied_usd), 0) FROM subscription_payments p WHERE p.charge_id = c.id) AS applied_usd
         FROM subscription_charges c
        WHERE c.restaurant_id = $1 AND c.status <> 'VOID'
        ORDER BY c.period_start DESC LIMIT 12`,
      [restaurantId]
    ),
    db.query(`${NOTICE_SQL} WHERE n.restaurant_id = $1 ORDER BY n.created_at DESC LIMIT 20`, [restaurantId]),
    settings.getPaymentDetails(),
    usdRate()
  ]);

  return {
    subscription: {
      tier: c.tier,
      state: c.state,
      status: c.subscriptionStatus,
      billingCycle: c.billingCycle,
      priceUsd: c.priceUsd,
      trialEndsAt: c.trialEndsAt,
      balanceUsd: c.balanceUsd,
      balanceVesToday: toVes(c.balanceUsd, rate)
    },
    charges: charges.rows.map(row => {
      const view = billing.chargeView(row);
      return { ...view, remainingVesToday: view.status === 'OPEN' ? toVes(view.remainingUsd, rate) : null };
    }),
    notices: notices.rows.map(noticeView),
    paymentDetails: settings.hasPaymentDetails(details) ? details : null,
    rate
  };
}

/** «Ya pagué». Queda pendiente hasta que alguien de Splite lo mire. */
async function submitNotice({ restaurantId, userId, input, meta = {} }) {
  const notice = await db.withTransaction(async client => {
    if (input.chargeId) {
      const { rows } = await client.query(
        'SELECT restaurant_id, status FROM subscription_charges WHERE id = $1', [input.chargeId]
      );
      if (!rows.length || rows[0].restaurant_id !== restaurantId) {
        throw new ApiError('SUBSCRIPTION_CHARGE_NOT_FOUND', 'Charge not found');
      }
      if (rows[0].status !== 'OPEN') {
        throw new ApiError('SUBSCRIPTION_CHARGE_CLOSED', 'This charge is already closed', { status: rows[0].status });
      }
    }
    try {
      const { rows } = await client.query(
        `INSERT INTO subscription_payment_notices
           (restaurant_id, charge_id, method, currency, amount, reference, paid_on, notes, submitted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::DATE, $8, $9)
         RETURNING *`,
        [restaurantId, input.chargeId || null, input.method, input.currency,
          String(money.toMinor(input.amount, 'Amount')), input.reference || null, input.paidOn,
          input.notes || null, userId]
      );
      return rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new ApiError('SUBSCRIPTION_NOTICE_DUPLICATE', 'That reference was already reported');
      }
      throw err;
    }
  });

  await logAudit({
    ...meta, restaurantId, actorId: userId, action: 'SUBSCRIPTION_PAYMENT_NOTICE',
    resourceType: 'subscription_payment_notice', resourceId: notice.id,
    details: { currency: notice.currency, amount: String(notice.amount), reference: notice.reference }
  });

  // Al equipo, para que no dependa de que alguien abra la consola. Si el correo
  // falla, el aviso ya está guardado y sale en Cobros igualmente.
  const { rows: r } = await db.query('SELECT name FROM restaurants WHERE id = $1', [restaurantId]);
  mailer.send({
    to: config.onboarding.teamEmail,
    subject: `Aviso de pago: ${r[0]?.name ?? restaurantId}`,
    text: [
      `${r[0]?.name ?? 'Un restaurante'} dice que pagó su suscripción.`,
      '',
      `Monto: ${money.toMinor(notice.amount)} (${notice.currency}, en céntimos)`,
      `Referencia: ${notice.reference ?? '—'}`,
      `Fecha: ${billing._internals.day(notice.paid_on)}`,
      '',
      `Confírmalo o recházalo en ${config.onboarding.appBaseUrl}/admin/cobros`
    ].join('\n')
  }).catch(err => logger.warn({ event: 'NOTICE_MAIL_FAILED', err }, 'Could not tell the team about a payment notice'));

  return noticeView(notice);
}

async function listNotices({ status = 'PENDING' } = {}) {
  const { rows } = await db.query(
    `${NOTICE_SQL} WHERE ($1::TEXT IS NULL OR n.status = $1::TEXT) ORDER BY n.created_at DESC LIMIT 200`,
    [status]
  );
  return rows.map(noticeView);
}

async function lockNotice(client, noticeId) {
  const { rows } = await client.query(
    'SELECT * FROM subscription_payment_notices WHERE id = $1 FOR UPDATE', [noticeId]
  );
  if (!rows.length) throw new ApiError('SUBSCRIPTION_NOTICE_NOT_FOUND', 'Notice not found');
  if (rows[0].status !== 'PENDING') {
    throw new ApiError('SUBSCRIPTION_NOTICE_CLOSED', 'This notice was already reviewed', { status: rows[0].status });
  }
  return rows[0];
}

/**
 * Confirmar: el dinero está en la cuenta de Splite. Registra el pago con los
 * datos del aviso -- en bolívares, a la tasa que se indique o la del BCV de
 * hoy -- y marca el aviso, en una sola transacción.
 */
async function confirmNotice({ operator, noticeId, fxRate = null, settle = false, meta = {} }) {
  const { rows } = await db.query('SELECT * FROM subscription_payment_notices WHERE id = $1', [noticeId]);
  if (!rows.length) throw new ApiError('SUBSCRIPTION_NOTICE_NOT_FOUND', 'Notice not found');
  const n = rows[0];
  const input = {
    chargeId: n.charge_id, method: n.method, currency: n.currency, amount: String(n.amount),
    fxRate, reference: n.reference, receivedOn: billing._internals.day(n.paid_on),
    notes: 'Confirmado desde un aviso del restaurante', settle
  };
  const prepared = await billing.preparePayment(input);

  return db.withTransaction(async client => {
    await lockNotice(client, noticeId);
    // Un cargo que se pagó entre el aviso y la confirmación: el pago se registra
    // igual, a cuenta, en vez de fallar con el dinero ya en el banco.
    let chargeId = input.chargeId;
    if (chargeId) {
      const { rows: ch } = await client.query('SELECT status FROM subscription_charges WHERE id = $1', [chargeId]);
      if (!ch.length || ch[0].status !== 'OPEN') chargeId = null;
    }
    const result = await billing.recordPaymentWith(client, {
      operator, restaurantId: n.restaurant_id, input: { ...input, chargeId }, prepared, meta
    });
    await client.query(
      `UPDATE subscription_payment_notices
          SET status = 'CONFIRMED', reviewed_by = $2, reviewed_at = NOW(), payment_id = $3
        WHERE id = $1`,
      [noticeId, operator.id, result.payment.id]
    );
    await operators.audit(client, {
      operatorId: operator.id, action: 'NOTICE_CONFIRMED', restaurantId: n.restaurant_id,
      resourceType: 'subscription_payment_notice', resourceId: noticeId,
      details: { paymentId: result.payment.id, appliedUsd: result.payment.appliedUsd }, meta
    });
    return result;
  });
}

/** Rechazar: no aparece en el banco, o no cuadra. El restaurante ve el motivo. */
async function rejectNotice({ operator, noticeId, reason, meta = {} }) {
  return db.withTransaction(async client => {
    const n = await lockNotice(client, noticeId);
    const { rows } = await client.query(
      `UPDATE subscription_payment_notices
          SET status = 'REJECTED', reviewed_by = $2, reviewed_at = NOW(), reject_reason = $3
        WHERE id = $1 RETURNING *`,
      [noticeId, operator.id, reason]
    );
    await operators.audit(client, {
      operatorId: operator.id, action: 'NOTICE_REJECTED', restaurantId: n.restaurant_id,
      resourceType: 'subscription_payment_notice', resourceId: noticeId, details: { reason }, meta
    });
    return noticeView(rows[0]);
  });
}

module.exports = { forRestaurant, submitNotice, listNotices, confirmNotice, rejectNotice, usdRate, toVes };
