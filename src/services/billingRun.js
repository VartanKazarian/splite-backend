const config = require('../config');
const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const fx = require('./fx');
const mailer = require('./mailer');
const billing = require('./platformBilling');
const settings = require('./platformSettings');
const notices = require('./subscriptionNotices');

/**
 * El pase nocturno de cobros: renovar y recordar.
 *
 * **Renovar.** Sólo a quien ya se le empezó a cobrar: el primer cargo lo
 * genera una persona desde la consola, que es quien decide cuándo empieza a
 * pagar un cliente. A partir de ahí, cuando termina un periodo se genera el
 * siguiente, con el precio de ese día. Suspendidos, cancelados y pruebas no se
 * renuevan.
 *
 * **Recordar.** Tres correos como mucho por cargo, cada uno una sola vez: al
 * generarse, al vencer y a los siete días de vencido. Nada se corta solo: lo
 * único que quita no pagar lo decide una persona en la consola (suspender).
 */

const REMINDER_KINDS = ['ISSUED', 'OVERDUE', 'OVERDUE_7'];

/** Cuántos periodos se ponen al día como mucho en una pasada. */
const MAX_CATCH_UP = 12;

async function renew({ today = fx.caracasToday() } = {}) {
  const { rows } = await db.query(
    `SELECT r.id, r.name
       FROM restaurants r
       LEFT JOIN restaurant_subscriptions s ON s.restaurant_id = r.id
      WHERE r.plan_tier <> 'TRIAL'
        AND COALESCE(s.status, 'ACTIVE') = 'ACTIVE'
        AND (SELECT max(c.period_end) FROM subscription_charges c
              WHERE c.restaurant_id = r.id AND c.status <> 'VOID') <= $1::DATE`,
    [today]
  );
  let created = 0;
  const skipped = [];
  for (const r of rows) {
    for (let i = 0; i < MAX_CATCH_UP; i++) {
      try {
        const charge = await billing.createCharge({ restaurantId: r.id, via: 'cron' });
        created += 1;
        if (charge.periodEnd > today) break;
      } catch (err) {
        skipped.push({ restaurant: r.name, code: err.code || 'ERROR' });
        logger.warn({ event: 'BILLING_RENEW_SKIPPED', restaurantId: r.id, code: err.code, err }, 'Could not renew');
        break;
      }
    }
  }
  return { created, skipped };
}

const usd = minor => {
  const s = String(minor).padStart(3, '0');
  return `$${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${s.slice(-2)}`;
};
const bs = minor => {
  const s = String(minor).padStart(3, '0');
  return `${s.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${s.slice(-2)} Bs`;
};

/** El texto de un recordatorio. Sin nada que no pueda leer el restaurante. */
function reminderText({ kind, restaurant, charge, remainingUsd, vesToday, details }) {
  const intro = {
    ISSUED: `Ya está disponible el cargo de tu suscripción a Splite (${charge.periodStart} → ${charge.periodEnd}).`,
    OVERDUE: `El cargo de tu suscripción a Splite venció el ${charge.dueOn} y todavía no nos consta el pago.`,
    OVERDUE_7: `El cargo de tu suscripción a Splite lleva una semana vencido (desde el ${charge.dueOn}).`
  }[kind];
  const lines = [
    `Hola, ${restaurant}.`,
    '',
    intro,
    '',
    `Monto: ${usd(remainingUsd)}${vesToday ? ` (≈ ${bs(vesToday)} a la tasa BCV de hoy)` : ''}`,
    `Vence: ${charge.dueOn}`,
    ''
  ];
  if (details) {
    lines.push('Puedes pagar a:');
    if (details.holder) lines.push(`  Titular: ${details.holder}`);
    if (details.idNumber) lines.push(`  RIF/Cédula: ${details.idNumber}`);
    if (details.bankName || details.bankCode) lines.push(`  Banco: ${[details.bankName, details.bankCode].filter(Boolean).join(' · ')}`);
    if (details.phone) lines.push(`  Pago Móvil: ${details.phone}`);
    if (details.accountNumber) lines.push(`  Cuenta: ${details.accountNumber}`);
    if (details.zelle) lines.push(`  Zelle: ${details.zelle}`);
    if (details.notes) lines.push(`  ${details.notes}`);
    lines.push('');
  }
  lines.push(
    `Cuando pagues, avísanos desde tu panel: ${config.onboarding.appBaseUrl}/settings#suscripcion`,
    '',
    'Si ya pagaste, ignora este correo: lo estamos comprobando.'
  );
  const subject = {
    ISSUED: 'Tu suscripción a Splite: nuevo cargo',
    OVERDUE: 'Tu suscripción a Splite: pago vencido',
    OVERDUE_7: 'Tu suscripción a Splite: una semana vencida'
  }[kind];
  return { subject, text: lines.join('\n') };
}

/** Qué recordatorio toca hoy: el más fuerte que aplique. */
function dueKind(charge, today) {
  const sevenAgo = billing.addDays(today, -7);
  if (charge.dueOn <= sevenAgo) return 'OVERDUE_7';
  if (charge.dueOn < today) return 'OVERDUE';
  return 'ISSUED';
}

async function remind({ today = fx.caracasToday() } = {}) {
  const { rows } = await db.query(
    `SELECT c.*, r.name AS restaurant_name,
            (SELECT COALESCE(SUM(p.applied_usd), 0) FROM subscription_payments p WHERE p.charge_id = c.id) AS applied_usd
       FROM subscription_charges c
       JOIN restaurants r ON r.id = c.restaurant_id
      WHERE c.status = 'OPEN'`
  );
  if (!rows.length) return { sent: 0, failed: 0, noRecipient: 0 };

  const [details, rate] = await Promise.all([settings.getPaymentDetails(), notices.usdRate()]);
  const payTo = settings.hasPaymentDetails(details) ? details : null;
  let sent = 0;
  let failed = 0;
  let noRecipient = 0;

  for (const row of rows) {
    const charge = billing.chargeView(row);
    const kind = dueKind(charge, today);
    const { rows: owners } = await db.query(
      `SELECT email FROM users WHERE restaurant_id = $1 AND role = 'OWNER' AND active AND email IS NOT NULL`,
      [charge.restaurantId]
    );
    if (!owners.length) { noRecipient += 1; continue; }

    // Se apunta antes de mandar, y los más flojos también: un cargo que nace
    // ya vencido recibe el correo de vencido, no además el de «nuevo cargo».
    const toMark = REMINDER_KINDS.slice(0, REMINDER_KINDS.indexOf(kind) + 1);
    const { rows: marked } = await db.query(
      `INSERT INTO billing_reminders (charge_id, kind)
       SELECT $1, k FROM unnest($2::TEXT[]) AS k
       ON CONFLICT DO NOTHING
       RETURNING kind`,
      [charge.id, toMark]
    );
    if (!marked.some(m => m.kind === kind)) continue;

    const message = reminderText({
      kind, restaurant: row.restaurant_name, charge,
      remainingUsd: charge.remainingUsd, vesToday: notices.toVes(charge.remainingUsd, rate), details: payTo
    });
    const result = await mailer.send({ to: owners.map(o => o.email).join(', '), ...message });
    if (result.sent) {
      sent += 1;
    } else {
      failed += 1;
      // Se desapunta para que el pase siguiente lo vuelva a intentar.
      await db.query('DELETE FROM billing_reminders WHERE charge_id = $1 AND kind = ANY($2::TEXT[])',
        [charge.id, marked.map(m => m.kind)]);
    }
  }
  return { sent, failed, noRecipient };
}

async function run(opts = {}) {
  const renewed = await renew(opts);
  const reminders = await remind(opts);
  return { renewed, reminders };
}

module.exports = { run, renew, remind, reminderText, dueKind, REMINDER_KINDS };
