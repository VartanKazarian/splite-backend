const db = require('../connectors/base');
const { claimsSummary } = require('./paymentClaims');

/**
 * What is happening in the restaurant right now.
 *
 * Everything here already existed as separate reads -- the floor, the claims
 * badge, the tips report, the C2P queue -- which meant a dashboard header cost
 * four or five calls and the client had to add up money to fill it in. Adding
 * up money on a client is the thing this codebase avoids everywhere else:
 * amounts cross the wire as strings precisely because a browser's Number loses
 * precision past 2^53, and a total assembled by summing them is the one figure
 * nobody checked.
 *
 * So the totals are computed in Postgres, in one call, and arrive already
 * summed.
 *
 * ---------------------------------------------------------------------------
 * On "today".
 *
 * There is no timezone column on `restaurants`, and this product is Venezuela
 * only -- VES settlement, Venezuelan banks, a Spanish surface -- so the default
 * window is the current day in America/Caracas rather than UTC. In UTC a
 * service that ends at 23:00 local lands in tomorrow, which would make the
 * takings figure wrong for the last four hours of every evening.
 *
 * A restaurant whose service crosses midnight should pass `from` explicitly.
 * That is the same rule the tips report teaches, for the same reason: a period
 * somebody guessed is a number they hand out money against.
 * ---------------------------------------------------------------------------
 */

/** Start of the current day in Venezuela, as a timestamptz Postgres can compare. */
const CARACAS_DAY_START = "date_trunc('day', NOW() AT TIME ZONE 'America/Caracas') AT TIME ZONE 'America/Caracas'";

/**
 * The floor, the queues and the day's takings, in one read.
 *
 * `from` bounds only the "since" figures -- takings, tips, bills closed. The
 * floor and the queues are always *now*: an open bill is open whatever window
 * somebody asked about.
 */
async function serviceSnapshot({ restaurantId, from = null }) {
  const [floor, taken, claims, c2p] = await Promise.all([
    db.query(
      `SELECT count(*)::int                                        AS tables_total,
              count(b.id)::int                                     AS tables_occupied,
              COALESCE(SUM(b.total_due_ves), 0)::BIGINT            AS due_ves,
              COALESCE(SUM(b.amount_paid_ves), 0)::BIGINT          AS paid_ves,
              MIN(b.created_at)                                    AS oldest_open_at
         FROM tables t
         LEFT JOIN bills b
           ON b.table_id = t.id AND b.restaurant_id = t.restaurant_id AND b.status = 'OPEN'
        WHERE t.restaurant_id = $1 AND t.active = true`,
      [restaurantId]
    ),

    // Settled *in* the window, read from the transition rather than the row's
    // creation, for the reason the tips report is: a declared Pago Movil is
    // created when the diner says they paid and settles when staff verify it,
    // and the takings figure is about money that has become real.
    db.query(
      `SELECT COALESCE(SUM(p.amount_ves), 0)::BIGINT AS taken_ves,
              COALESCE(SUM(p.tip_ves), 0)::BIGINT    AS tips_ves,
              count(*)::int                          AS payments
         FROM payment_transitions t
         JOIN payments p
           ON p.id = t.payment_id AND p.restaurant_id = t.restaurant_id
        WHERE t.restaurant_id = $1
          AND t.to_status = 'SUCCEEDED'
          AND t.created_at >= COALESCE($2::timestamptz, ${CARACAS_DAY_START})
          AND p.status = 'SUCCEEDED'`,
      [restaurantId, from]
    ),

    claimsSummary({ restaurantId }),

    // Tenant-scoped, unlike the same figure on /metrics: a restaurant sees its
    // own queue, an operator sees the installation's.
    db.query(
      `SELECT status, count(*)::int AS count
         FROM payments
        WHERE restaurant_id = $1
          AND payment_method = 'C2P'
          AND status IN ('IN_DOUBT', 'AMBIGUOUS')
        GROUP BY status`,
      [restaurantId]
    )
  ]);

  const f = floor.rows[0];
  const t = taken.rows[0];
  const unresolved = Object.fromEntries(c2p.rows.map(r => [r.status, r.count]));

  const due = BigInt(f.due_ves);
  const paid = BigInt(f.paid_ves);

  return {
    asOf: new Date().toISOString(),
    // Echoed back so a client can show what period the figures cover rather
    // than assuming it matched what it asked for.
    since: from ? new Date(from).toISOString() : null,
    tables: {
      total: f.tables_total,
      occupied: f.tables_occupied,
      free: f.tables_total - f.tables_occupied
    },
    openBills: {
      count: f.tables_occupied,
      totalDueVes: due.toString(),
      amountPaidVes: paid.toString(),
      // What the room still owes. The number a manager looks at first.
      outstandingVes: (due - paid).toString(),
      oldestOpenedAt: f.oldest_open_at ? new Date(f.oldest_open_at).toISOString() : null
    },
    taken: {
      paymentsVes: t.taken_ves,
      tipsVes: t.tips_ves,
      payments: t.payments
    },
    claims: {
      pending: claims.pending,
      oldestPendingAt: claims.oldestPendingAt,
      oldestPendingAgeSeconds: claims.oldestPendingAgeSeconds
    },
    // Money a diner has been debited for that only a person can resolve.
    unresolvedC2P: {
      inDoubt: unresolved.IN_DOUBT ?? 0,
      ambiguous: unresolved.AMBIGUOUS ?? 0
    }
  };
}

/**
 * What has happened since the client last looked.
 *
 * The ask behind this is "tell staff when a payment lands". Real push is a
 * frontend and infrastructure decision -- a service worker, a subscription
 * store, a sender -- and none of that is built. What a dashboard needs to poll
 * cheaply is a cursor, so this is one.
 *
 * Two kinds of thing, because they call for different reactions:
 *
 *   SETTLED   money became real. Table 6 has paid.
 *   DECLARED  a diner *says* they paid. Somebody has to look at the bank app.
 *
 * Ordered oldest first so a client can render them in the order they happened
 * and keep the last `at` as its next cursor. `asOf` is returned for the case
 * where nothing happened at all, so the cursor still advances and the next poll
 * does not re-scan the same window forever.
 */
async function activitySince({ restaurantId, since = null, limit = 50 }) {
  const { rows } = await db.query(
    `WITH settled AS (
       SELECT 'SETTLED'::text  AS kind, t.created_at AS at, p.id AS payment_id,
              p.bill_id, p.amount_ves, p.tip_ves, p.payment_method
         FROM payment_transitions t
         JOIN payments p
           ON p.id = t.payment_id AND p.restaurant_id = t.restaurant_id
        WHERE t.restaurant_id = $1
          AND t.to_status = 'SUCCEEDED'
          AND ($2::timestamptz IS NULL OR t.created_at > $2)
     ),
     declared AS (
       SELECT 'DECLARED'::text AS kind, p.created_at AS at, p.id AS payment_id,
              p.bill_id, p.amount_ves, p.tip_ves, p.payment_method
         FROM payments p
        WHERE p.restaurant_id = $1
          AND p.payment_method = 'PAGO_MOVIL'
          AND p.status = 'PENDING'
          AND ($2::timestamptz IS NULL OR p.created_at > $2)
     )
     SELECT e.*, b.table_id, tb.name AS table_name
       FROM (SELECT * FROM settled UNION ALL SELECT * FROM declared) e
       JOIN bills b ON b.id = e.bill_id AND b.restaurant_id = $1
       LEFT JOIN tables tb ON tb.id = b.table_id AND tb.restaurant_id = $1
      ORDER BY e.at ASC
      LIMIT $3`,
    [restaurantId, since, limit]
  );

  return {
    asOf: new Date().toISOString(),
    since: since ? new Date(since).toISOString() : null,
    data: rows.map(r => ({
      kind: r.kind,
      at: new Date(r.at).toISOString(),
      paymentId: r.payment_id,
      billId: r.bill_id,
      tableId: r.table_id,
      tableName: r.table_name,
      amountVes: r.amount_ves,
      tipVes: r.tip_ves,
      paymentMethod: r.payment_method
    }))
  };
}

module.exports = { serviceSnapshot, activitySince };
