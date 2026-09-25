const db = require('../connectors/base');
const fx = require('./fx');
const billing = require('./platformBilling');

/**
 * Cómo va el negocio, en una pantalla.
 *
 * Todo sale de lo que ya hay -- restaurantes, cargos, pagos y el rastro de la
 * consola --, sin tablas de métricas aparte que haya que mantener al día.
 * Los meses son de Caracas.
 */

const MONTHS = 6;

function monthKeys(today, n = MONTHS) {
  const [y, m] = today.split('-').map(Number);
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}

async function summary() {
  const today = fx.caracasToday();
  const months = monthKeys(today);
  const from = `${months[0]}-01`;

  const [clients, created, charged, collected, conversion, cancelled, pending] = await Promise.all([
    billing.listClients(),
    db.query(
      `SELECT to_char(created_at AT TIME ZONE 'America/Caracas', 'YYYY-MM') AS m, count(*)::INT AS n
         FROM restaurants WHERE created_at >= $1::DATE GROUP BY 1`,
      [from]
    ),
    db.query(
      `SELECT to_char(period_start, 'YYYY-MM') AS m, COALESCE(SUM(amount_usd), 0) AS usd
         FROM subscription_charges WHERE status <> 'VOID' AND period_start >= $1::DATE GROUP BY 1`,
      [from]
    ),
    db.query(
      `SELECT to_char(received_on, 'YYYY-MM') AS m, COALESCE(SUM(applied_usd), 0) AS usd
         FROM subscription_payments WHERE received_on >= $1::DATE GROUP BY 1`,
      [from]
    ),
    // De los restaurantes que llegaron en los últimos 180 días, cuántos pagan
    // hoy un plan: la conversión de prueba a cliente.
    db.query(
      `SELECT count(*)::INT AS total,
              count(*) FILTER (WHERE r.plan_tier <> 'TRIAL'
                               AND COALESCE(s.status, 'ACTIVE') <> 'CANCELLED')::INT AS paying
         FROM restaurants r LEFT JOIN restaurant_subscriptions s ON s.restaurant_id = r.id
        WHERE r.created_at >= NOW() - INTERVAL '180 days'`
    ),
    db.query(
      `SELECT count(DISTINCT restaurant_id)::INT AS n FROM operator_audit
        WHERE action = 'SUBSCRIPTION_UPDATED'
          AND details->'after'->>'status' = 'CANCELLED'
          AND details->'before'->>'status' <> 'CANCELLED'
          AND created_at > NOW() - INTERVAL '30 days'`
    ),
    db.query("SELECT count(*)::INT AS n FROM subscription_payment_notices WHERE status = 'PENDING'")
  ]);

  const byMonth = (rows, field) => Object.fromEntries(rows.map(r => [r.m, r[field]]));
  const newBy = byMonth(created.rows, 'n');
  const chargedBy = byMonth(charged.rows, 'usd');
  const collectedBy = byMonth(collected.rows, 'usd');
  const conv = conversion.rows[0];

  return {
    monthlyRecurringUsd: clients.summary.monthlyRecurringUsd,
    outstandingUsd: clients.summary.outstandingUsd,
    byState: clients.summary.byState,
    totalClients: clients.summary.total,
    pendingNotices: pending.rows[0].n,
    trialConversion: {
      windowDays: 180,
      started: conv.total,
      paying: conv.paying,
      // Entero en puntos básicos para no mandar flotantes: 2500 = 25 %.
      rateBps: conv.total ? Math.round((conv.paying * 10000) / conv.total) : null
    },
    cancelledLast30Days: cancelled.rows[0].n,
    months: months.map(m => ({
      month: m,
      newClients: newBy[m] ?? 0,
      chargedUsd: String(chargedBy[m] ?? 0),
      collectedUsd: String(collectedBy[m] ?? 0)
    }))
  };
}

module.exports = { summary, _internals: { monthKeys } };
