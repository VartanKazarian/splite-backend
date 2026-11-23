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

  const [clients, created, charged, collected, conversion, cancelled, pending, volume, funnel, aging, recent] = await Promise.all([
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
    db.query("SELECT count(*)::INT AS n FROM subscription_payment_notices WHERE status = 'PENDING'"),
    // Lo que pasa por Splite cada mes, a la tasa de cada cuenta, y cuántos
    // restaurantes cobraron algo: el tamaño real del negocio de los clientes.
    db.query(
      `SELECT to_char(p.created_at AT TIME ZONE 'America/Caracas', 'YYYY-MM') AS m,
              COALESCE(ROUND(SUM(p.amount_ves / NULLIF(b.fx_rate_ves_per_unit, 0))), 0) AS usd,
              count(DISTINCT p.restaurant_id)::INT AS restaurants,
              count(*)::INT AS payments,
              count(*) FILTER (WHERE p.payer_type = 'GUEST')::INT AS guest
         FROM payments p
         JOIN bills b ON b.id = p.bill_id AND b.restaurant_id = p.restaurant_id
        WHERE p.status = 'SUCCEEDED' AND p.created_at >= $1::DATE
        GROUP BY 1`,
      [from]
    ),
    // De los que llegaron en 180 días, hasta dónde ha llegado cada uno.
    db.query(
      `SELECT count(*)::INT AS signed_up,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM tables t WHERE t.restaurant_id = r.id)
                                 AND EXISTS (SELECT 1 FROM menu_products m WHERE m.restaurant_id = r.id))::INT AS set_up,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM bills b WHERE b.restaurant_id = r.id))::INT AS first_bill,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM payments p WHERE p.restaurant_id = r.id
                                               AND p.status = 'SUCCEEDED' AND p.payer_type = 'GUEST'))::INT AS first_qr_payment,
              count(*) FILTER (WHERE r.plan_tier <> 'TRIAL'
                                 AND COALESCE(s.status, 'ACTIVE') <> 'CANCELLED')::INT AS paying
         FROM restaurants r LEFT JOIN restaurant_subscriptions s ON s.restaurant_id = r.id
        WHERE r.created_at >= NOW() - INTERVAL '180 days'`
    ),
    // Lo que se debe, por antigüedad desde el vencimiento.
    db.query(
      `WITH open AS (
         SELECT c.due_on,
                c.amount_usd - COALESCE((SELECT SUM(p.applied_usd) FROM subscription_payments p WHERE p.charge_id = c.id), 0) AS remaining
           FROM subscription_charges c WHERE c.status = 'OPEN'
       )
       SELECT COALESCE(SUM(remaining) FILTER (WHERE due_on >= $1::DATE), 0) AS current,
              COALESCE(SUM(remaining) FILTER (WHERE due_on < $1::DATE AND due_on >= $1::DATE - 30), 0) AS d1_30,
              COALESCE(SUM(remaining) FILTER (WHERE due_on < $1::DATE - 30 AND due_on >= $1::DATE - 60), 0) AS d31_60,
              COALESCE(SUM(remaining) FILTER (WHERE due_on < $1::DATE - 60), 0) AS d61_plus
         FROM open WHERE remaining > 0`,
      [today]
    ),
    // Los últimos 30 días contra los 30 anteriores.
    db.query(
      `SELECT COALESCE(ROUND(SUM(p.amount_ves / NULLIF(b.fx_rate_ves_per_unit, 0))
                FILTER (WHERE p.created_at > NOW() - INTERVAL '30 days')), 0) AS usd,
              COALESCE(ROUND(SUM(p.amount_ves / NULLIF(b.fx_rate_ves_per_unit, 0))
                FILTER (WHERE p.created_at <= NOW() - INTERVAL '30 days')), 0) AS prev_usd,
              count(*) FILTER (WHERE p.created_at > NOW() - INTERVAL '30 days')::INT AS payments,
              count(*) FILTER (WHERE p.created_at > NOW() - INTERVAL '30 days' AND p.payer_type = 'GUEST')::INT AS guest
         FROM payments p
         JOIN bills b ON b.id = p.bill_id AND b.restaurant_id = p.restaurant_id
        WHERE p.status = 'SUCCEEDED' AND p.created_at > NOW() - INTERVAL '60 days'`
    )
  ]);

  const byMonth = (rows, field) => Object.fromEntries(rows.map(r => [r.m, r[field]]));
  const newBy = byMonth(created.rows, 'n');
  const chargedBy = byMonth(charged.rows, 'usd');
  const collectedBy = byMonth(collected.rows, 'usd');
  const conv = conversion.rows[0];
  const volBy = Object.fromEntries(volume.rows.map(r => [r.m, r]));
  const f = funnel.rows[0];
  const a = aging.rows[0];
  const r30 = recent.rows[0];
  const bps = (n, d) => (d ? Math.round((n * 10000) / d) : null);
  const payingClients = clients.data.filter(c =>
    (c.state === 'ACTIVE' || c.state === 'OVERDUE') && c.monthlyValueUsd && BigInt(c.monthlyValueUsd) > 0n
  ).length;

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
    byHealth: clients.summary.byHealth,
    payingClients,
    // Ingreso medio por cliente que paga, al mes.
    averageRevenueUsd: payingClients
      ? String(BigInt(clients.summary.monthlyRecurringUsd) / BigInt(payingClients))
      : null,
    processed30d: {
      volumeUsd: String(r30.usd),
      previousVolumeUsd: String(r30.prev_usd),
      payments: r30.payments,
      guestShareBps: bps(r30.guest, r30.payments)
    },
    funnel: {
      windowDays: 180,
      signedUp: f.signed_up,
      setUp: f.set_up,
      firstBill: f.first_bill,
      firstQrPayment: f.first_qr_payment,
      paying: f.paying
    },
    aging: {
      currentUsd: String(a.current),
      days1to30Usd: String(a.d1_30),
      days31to60Usd: String(a.d31_60),
      days61PlusUsd: String(a.d61_plus)
    },
    months: months.map(m => ({
      month: m,
      newClients: newBy[m] ?? 0,
      chargedUsd: String(chargedBy[m] ?? 0),
      collectedUsd: String(collectedBy[m] ?? 0),
      processedUsd: String(volBy[m]?.usd ?? 0),
      activeRestaurants: volBy[m]?.restaurants ?? 0,
      guestShareBps: volBy[m] ? bps(volBy[m].guest, volBy[m].payments) : null
    }))
  };
}

module.exports = { summary, _internals: { monthKeys } };
