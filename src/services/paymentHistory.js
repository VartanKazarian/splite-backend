'use strict';

const db = require('../connectors/base');

/**
 * Every payment of the last few days, newest first.
 *
 * The activity feed answers "what just happened"; this answers "what happened
 * this week". They are different questions with different shapes: the feed is
 * a cursor forward from now, this is a fixed window paged backwards, and it
 * lists payments in every state -- a failed card or a rejected Pago Móvil is
 * exactly what somebody scrolling back through Tuesday is looking for.
 *
 * The window is rolling (`days` × 24 h back from now), not calendar days in the
 * restaurant's timezone. "Últimos 7 días" read at 10 a.m. includes last
 * Monday's dinner service, which is what a person means by it.
 *
 * Paged with a keyset on (created_at, id) rather than an offset, so a payment
 * arriving while somebody pages does not shift every later page by one. The
 * cursor carries the timestamp as Postgres prints it -- microseconds included
 * -- because a JavaScript Date would round it to milliseconds and the cursor
 * would land just before the row it names, returning it twice.
 */

const MAX_DAYS = 90;
const TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;

function encodeCursor(row) {
  return Buffer.from(`${row.created_at_text}|${row.id}`, 'utf8').toString('base64url');
}

/** `null` for anything that does not decode: a bad cursor is the first page, not a 500. */
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    // Exactly the shape `timestamptz::text` prints. Not `Date.parse`: it rejects
    // the `+00` offset Postgres writes, and it is the database that reads this.
    if (!TS.test(at || '') || !/^[0-9a-f-]{36}$/i.test(id || '')) {
      return null;
    }
    return { at, id };
  } catch {
    return null;
  }
}

async function paymentHistory({ restaurantId, days = 7, cursor = null, limit = 50 }) {
  const window = Math.min(Math.max(Math.trunc(days) || 7, 1), MAX_DAYS);
  const after = decodeCursor(cursor);

  // `from` is computed once, in the database, so the page and the totals are
  // over the same window even if the second query starts a moment later.
  const { rows: [{ from_at: fromAt }] } = await db.query(
    `SELECT now() - make_interval(days => $1::int) AS from_at`,
    [window]
  );

  const [page, totals] = await Promise.all([
    db.query(
      `SELECT p.id, p.created_at, p.created_at::text AS created_at_text,
              p.bill_id, p.amount_ves, p.tip_ves, p.payment_method, p.status,
              p.declared_reference, b.table_id, tb.name AS table_name
         FROM payments p
         JOIN bills b ON b.id = p.bill_id AND b.restaurant_id = p.restaurant_id
         LEFT JOIN tables tb ON tb.id = b.table_id AND tb.restaurant_id = p.restaurant_id
        WHERE p.restaurant_id = $1
          AND p.created_at >= $2
          AND ($3::timestamptz IS NULL OR (p.created_at, p.id) < ($3::timestamptz, $4::uuid))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $5`,
      [restaurantId, fromAt, after?.at ?? null, after?.id ?? null, limit + 1]
    ),
    // Totals are for the whole window, not the page: "esta semana entraron
    // Bs. X" must not change as somebody presses "Cargar más".
    db.query(
      `SELECT count(*)::int AS count,
              count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded_count,
              COALESCE(sum(amount_ves) FILTER (WHERE status = 'SUCCEEDED'), 0)::text AS succeeded_ves,
              COALESCE(sum(tip_ves) FILTER (WHERE status = 'SUCCEEDED'), 0)::text AS tip_ves
         FROM payments
        WHERE restaurant_id = $1 AND created_at >= $2`,
      [restaurantId, fromAt]
    )
  ]);

  const rows = page.rows.slice(0, limit);
  const more = page.rows.length > limit;
  const t = totals.rows[0];

  return {
    days: window,
    from: new Date(fromAt).toISOString(),
    totals: {
      count: t.count,
      succeededCount: t.succeeded_count,
      succeededVes: t.succeeded_ves,
      tipVes: t.tip_ves
    },
    nextCursor: more ? encodeCursor(rows[rows.length - 1]) : null,
    data: rows.map(r => ({
      paymentId: r.id,
      at: new Date(r.created_at).toISOString(),
      billId: r.bill_id,
      tableId: r.table_id,
      tableName: r.table_name,
      amountVes: String(r.amount_ves),
      tipVes: String(r.tip_ves),
      paymentMethod: r.payment_method,
      status: r.status,
      reference: r.declared_reference
    }))
  };
}

module.exports = { paymentHistory, decodeCursor, MAX_DAYS };
