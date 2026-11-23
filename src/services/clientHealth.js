'use strict';

const db = require('../connectors/base');

/**
 * Cómo usa Splite cada cliente, y si hay que llamarle.
 *
 * Lo de facturación dice si un restaurante paga; esto dice si le sirve. Un
 * cliente al día que lleva dos semanas sin abrir una cuenta se va a ir en la
 * próxima renovación, y es ahora cuando todavía se le puede llamar.
 *
 * Todo sale de cuentas y cobros, sin tablas de métricas aparte. Ventanas de 30
 * días hacia atrás desde ahora, y la anterior para comparar.
 */

/**
 * Una consulta para todos (o para uno): lo justo para la lista de clientes.
 *
 * `usd` convierte cada cobro a la tasa de su cuenta, no a la de hoy: con la
 * inflación del bolívar, comparar meses en Bs. no dice nada.
 */
async function activityByRestaurant(restaurantId = null) {
  const { rows } = await db.query(
    `WITH pay AS (
       SELECT p.restaurant_id,
              COALESCE(SUM(p.amount_ves) FILTER (WHERE p.status = 'SUCCEEDED' AND p.created_at > NOW() - INTERVAL '30 days'), 0) AS vol,
              COALESCE(SUM(p.amount_ves) FILTER (WHERE p.status = 'SUCCEEDED' AND p.created_at <= NOW() - INTERVAL '30 days'), 0) AS prev_vol,
              COALESCE(ROUND(SUM(p.amount_ves / NULLIF(b.fx_rate_ves_per_unit, 0))
                FILTER (WHERE p.status = 'SUCCEEDED' AND p.created_at > NOW() - INTERVAL '30 days')), 0) AS vol_usd,
              count(*) FILTER (WHERE p.status = 'SUCCEEDED' AND p.created_at > NOW() - INTERVAL '30 days')::INT AS paid,
              count(*) FILTER (WHERE p.status = 'SUCCEEDED' AND p.payer_type = 'GUEST' AND p.created_at > NOW() - INTERVAL '30 days')::INT AS guest_paid,
              count(*) FILTER (WHERE p.status IN ('FAILED', 'IN_DOUBT', 'AMBIGUOUS') AND p.created_at > NOW() - INTERVAL '30 days')::INT AS failed,
              count(*) FILTER (WHERE p.created_at > NOW() - INTERVAL '30 days')::INT AS attempts
         FROM payments p
         JOIN bills b ON b.id = p.bill_id AND b.restaurant_id = p.restaurant_id
        WHERE p.created_at > NOW() - INTERVAL '60 days'
          AND ($1::UUID IS NULL OR p.restaurant_id = $1)
        GROUP BY p.restaurant_id
     ),
     bl AS (
       SELECT restaurant_id, count(*)::INT AS bills,
              count(DISTINCT (created_at AT TIME ZONE 'America/Caracas')::DATE)::INT AS active_days
         FROM bills
        WHERE created_at > NOW() - INTERVAL '30 days'
          AND ($1::UUID IS NULL OR restaurant_id = $1)
        GROUP BY restaurant_id
     )
     SELECT r.id,
            COALESCE(pay.vol, 0) AS vol, COALESCE(pay.prev_vol, 0) AS prev_vol, COALESCE(pay.vol_usd, 0) AS vol_usd,
            COALESCE(pay.paid, 0) AS paid, COALESCE(pay.guest_paid, 0) AS guest_paid,
            COALESCE(pay.failed, 0) AS failed, COALESCE(pay.attempts, 0) AS attempts,
            COALESCE(bl.bills, 0) AS bills, COALESCE(bl.active_days, 0) AS active_days,
            EXISTS (SELECT 1 FROM menu_products m WHERE m.restaurant_id = r.id) AS has_menu,
            EXISTS (SELECT 1 FROM tables t WHERE t.restaurant_id = r.id) AS has_tables,
            EXISTS (SELECT 1 FROM bank_connections k WHERE k.restaurant_id = r.id AND k.active) AS has_bank
       FROM restaurants r
       LEFT JOIN pay ON pay.restaurant_id = r.id
       LEFT JOIN bl ON bl.restaurant_id = r.id
      WHERE $1::UUID IS NULL OR r.id = $1`,
    [restaurantId]
  );
  return new Map(rows.map(r => [r.id, r]));
}

function activityView(row) {
  if (!row) return null;
  return {
    volumeVes: String(row.vol),
    volumeUsd: String(row.vol_usd),
    previousVolumeVes: String(row.prev_vol),
    bills: row.bills,
    activeDays: row.active_days,
    payments: row.paid,
    // Cuántos cobros hizo el comensal desde el QR, en puntos básicos. Es la
    // cifra de adopción: un restaurante que lo cobra todo a mano no usa Splite.
    guestShareBps: row.paid ? Math.round((row.guest_paid * 10000) / row.paid) : null,
    failedPayments: row.failed
  };
}

const DAY = 86_400_000;

/**
 * Una nota de 0 a 100 y por qué.
 *
 * Restar por motivos con nombre, en vez de un modelo, para que quien la lee
 * sepa qué hacer: «14 días sin actividad» es una llamada; «62» no es nada.
 * Los pesos son un punto de partida y están aquí para cambiarlos.
 *
 * Un cliente cancelado no tiene nota: ya no hay nada que salvar.
 */
function healthOf(client, row, now = Date.now()) {
  if (client.state === 'CANCELLED' || !row) return null;
  const reasons = [];
  let score = 100;
  const hit = (code, points) => { reasons.push(code); score -= points; };

  const ageDays = (now - new Date(client.createdAt).getTime()) / DAY;
  const idleDays = client.lastActivityAt
    ? (now - new Date(client.lastActivityAt).getTime()) / DAY
    : ageDays;

  // Recién llegado: no se le puede pedir actividad todavía, sí la configuración.
  if (ageDays >= 7) {
    if (idleDays > 14) hit('INACTIVE_14D', 40);
    else if (idleDays > 7) hit('INACTIVE_7D', 20);
  }

  const vol = BigInt(row.vol);
  const prev = BigInt(row.prev_vol);
  if (prev > 0n && idleDays <= 14) {
    if (vol * 2n < prev) hit('VOLUME_DROP_50', 20);
    else if (vol * 4n < prev * 3n) hit('VOLUME_DROP_25', 10);
  }

  if (client.state === 'OVERDUE') hit('OVERDUE', 25);
  if (client.state === 'SUSPENDED') hit('SUSPENDED', 30);
  if (client.state === 'TRIAL_EXPIRED') hit('TRIAL_EXPIRED', 15);

  if (!row.has_tables) hit('NO_TABLES', 15);
  if (!row.has_menu) hit('NO_MENU', 10);
  if (!row.has_bank) hit('NO_BANK', 5);

  if (row.attempts >= 10 && row.failed * 10 > row.attempts) hit('PAYMENT_FAILURES', 10);

  score = Math.max(0, score);
  return { score, level: score >= 70 ? 'GOOD' : score >= 40 ? 'WATCH' : 'RISK', reasons };
}

/**
 * La ficha: el mes día a día, por método, y lo que cobra cada cuenta.
 */
async function trendFor(restaurantId) {
  const [daily, methods, totals] = await Promise.all([
    db.query(
      `WITH days AS (
         SELECT generate_series(
           ((NOW() AT TIME ZONE 'America/Caracas')::DATE - 29),
           (NOW() AT TIME ZONE 'America/Caracas')::DATE, INTERVAL '1 day')::DATE AS d
       )
       SELECT to_char(days.d, 'YYYY-MM-DD') AS date,
              (SELECT count(*)::INT FROM bills b
                WHERE b.restaurant_id = $1 AND (b.created_at AT TIME ZONE 'America/Caracas')::DATE = days.d) AS bills,
              (SELECT COALESCE(SUM(p.amount_ves), 0) FROM payments p
                WHERE p.restaurant_id = $1 AND p.status = 'SUCCEEDED'
                  AND (p.created_at AT TIME ZONE 'America/Caracas')::DATE = days.d) AS volume_ves
         FROM days ORDER BY days.d`,
      [restaurantId]
    ),
    db.query(
      `SELECT payment_method AS method, count(*)::INT AS n, COALESCE(SUM(amount_ves), 0) AS ves
         FROM payments
        WHERE restaurant_id = $1 AND status = 'SUCCEEDED' AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY 1 ORDER BY 3 DESC`,
      [restaurantId]
    ),
    db.query(
      `SELECT COALESCE(SUM(p.tip_ves), 0) AS tips,
              count(DISTINCT p.bill_id)::INT AS paid_bills,
              COALESCE(SUM(p.amount_ves), 0) AS ves
         FROM payments p
        WHERE p.restaurant_id = $1 AND p.status = 'SUCCEEDED' AND p.created_at > NOW() - INTERVAL '30 days'`,
      [restaurantId]
    )
  ]);
  const t = totals.rows[0];
  return {
    daily: daily.rows.map(r => ({ date: r.date, bills: r.bills, volumeVes: String(r.volume_ves) })),
    methods: methods.rows.map(r => ({ method: r.method, payments: r.n, volumeVes: String(r.ves) })),
    tipsVes: String(t.tips),
    // Lo que deja una cuenta de media, sobre las cuentas que recibieron algún cobro.
    averageBillVes: t.paid_bills ? String(BigInt(t.ves) / BigInt(t.paid_bills)) : null
  };
}

module.exports = { activityByRestaurant, activityView, healthOf, trendFor };
