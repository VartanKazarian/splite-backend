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
/**
 * Cómo llegó el dinero, que no es lo mismo que dónde está.
 *
 * El informe de propinas ya reparte por método, pero responde a otra pregunta
 * -- si el dinero está en el cajón o se le debe al personal. Aquí la pregunta
 * es quién lo metió: si el comensal pagó solo desde su teléfono o si alguien
 * de la casa tuvo que teclearlo. Un turno en el que la mitad de las ventas se
 * teclearon a mano es un turno en el que el QR no está funcionando, y eso no
 * se ve en un total.
 *
 * Tres cubos y no dos, por lo mismo que en las propinas: `SPLITE` es lo que el
 * endpoint de caja grababa cuando el cliente no decía cómo había entrado el
 * dinero, y `OTHER` es explícitamente desconocido. Meterlos en cualquiera de
 * los dos primeros sería adivinar, así que se cuentan como lo que son.
 */
const APP_METHODS = new Set(['C2P', 'PAGO_MOVIL']);
const TILL_METHODS = new Set(['CASH', 'CARD', 'TRANSFER']);

function takings(rows) {
  const bucket = () => ({ paymentsVes: 0n, payments: 0 });
  const app = bucket();
  const till = bucket();
  const unclassified = bucket();
  let tips = 0n;

  for (const row of rows) {
    const amount = BigInt(row.taken_ves);
    tips += BigInt(row.tips_ves);
    const into = APP_METHODS.has(row.method)
      ? app
      : TILL_METHODS.has(row.method)
        ? till
        : unclassified;
    into.paymentsVes += amount;
    into.payments += row.payments;
  }

  const out = b => ({ paymentsVes: b.paymentsVes.toString(), payments: b.payments });
  return {
    // Sumados de los mismos cubos que se devuelven, no de una segunda consulta.
    paymentsVes: (app.paymentsVes + till.paymentsVes + unclassified.paymentsVes).toString(),
    tipsVes: tips.toString(),
    payments: app.payments + till.payments + unclassified.payments,
    byChannel: { app: out(app), till: out(till), unclassified: out(unclassified) }
  };
}

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
    //
    // Grouped by method so the totals can be split by how the money arrived.
    // The totals themselves are summed from these groups, so the two halves of
    // the figure cannot drift apart.
    db.query(
      `SELECT p.payment_method                       AS method,
              COALESCE(SUM(p.amount_ves), 0)::BIGINT AS taken_ves,
              COALESCE(SUM(p.tip_ves), 0)::BIGINT    AS tips_ves,
              count(*)::int                          AS payments
         FROM payment_transitions t
         JOIN payments p
           ON p.id = t.payment_id AND p.restaurant_id = t.restaurant_id
        WHERE t.restaurant_id = $1
          AND t.to_status = 'SUCCEEDED'
          AND t.created_at >= COALESCE($2::timestamptz, ${CARACAS_DAY_START})
          AND p.status = 'SUCCEEDED'
        GROUP BY p.payment_method`,
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
  const t = takings(taken.rows);
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
      paymentsVes: t.paymentsVes,
      tipsVes: t.tipsVes,
      payments: t.payments,
      byChannel: t.byChannel
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
 *
 * **Which end the limit cuts from depends on whether there is a cursor**, and
 * getting that wrong is what this used to do. With a cursor the window is
 * "everything after `since`", so the limit takes the *oldest* of those and the
 * client walks forward. With no cursor there is no window: the caller means
 * "the latest", and taking the oldest N of all history hands back a
 * restaurant's first twenty payments, forever. Measured against a real ledger:
 * asking for five returned five from three days earlier while the newest was
 * two hours old, and once a restaurant passes the limit the feed freezes on its
 * opening day and never moves again.
 *
 * So the cut is made from the new end and the page is turned back around before
 * returning, which keeps one promise for both cases: the array is always oldest
 * first.
 *
 * **The cursor is `asOf`, never an entry's `at`.** Postgres keeps these
 * timestamps to the microsecond and `toISOString()` only carries milliseconds,
 * so an `at` handed back as `since` is *earlier* than the row it came from --
 * `21:07:04.123456 > 21:07:04.123` is true -- and that row arrives again on
 * every poll, forever. `at` is for showing; `asOf` is for paging, which is what
 * the published contract tells clients to use.
 */
async function activitySince({ restaurantId, since = null, limit = 50 }) {
  // Sin cursor, "dame veinte" significa las veinte últimas.
  const latest = since === null;
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
      ORDER BY e.at ${latest ? 'DESC' : 'ASC'}
      LIMIT $3`,
    [restaurantId, since, limit]
  );

  // Interpolado y no parametrizado porque una dirección de ordenación no es un
  // valor: es sintaxis, y ésta sale de un booleano de aquí dentro, nunca del
  // cliente.
  if (latest) rows.reverse();

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
