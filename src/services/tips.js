const db = require('../connectors/base');

/**
 * What the restaurant owes its staff.
 *
 * Tips are pooled and handed out at the end of a shift, so the question is
 * always the same: how much came in over this period, and how did it arrive.
 * That second half is not decoration. A cash tip is already in the till -- the
 * money is physically there and the restaurant is only deciding how to divide
 * it. An electronic tip arrived in the restaurant's bank account, so it is a
 * debt to staff until it is paid out. Reporting one number for both would
 * describe two different situations identically.
 *
 * Only SUCCEEDED payments count. A tip on a PENDING Pago Móvil claim is money
 * a diner says they sent; counting it would have a restaurant hand out cash
 * against a transfer nobody has verified. IN_DOUBT and AMBIGUOUS are excluded
 * for the same reason, and more sharply -- those are charges we cannot yet
 * prove landed at all.
 */

/**
 * Where a tip physically is, by how the payment arrived.
 *
 * Three buckets, not two, and the third is the important one. `SPLITE` is what
 * the till endpoint records when the client does not say how the money came in,
 * and `OTHER` is explicitly unknown -- neither can be called cash or bank
 * without guessing. Filing them under "owed" would have a restaurant hand out
 * money already sitting in its own drawer; filing them under "in the till"
 * would quietly cancel a real debt to staff. So they are reported as what they
 * are: not classified.
 *
 * Kept as sets rather than a flag on the row because it is a property of how
 * the money arrived, which `payment_method` already records.
 */
const IN_TILL_METHODS = new Set(['CASH']);
const OWED_METHODS = new Set(['CARD', 'TRANSFER', 'PAGO_MOVIL', 'C2P']);

/**
 * Tips over a period, in total and by how they arrived.
 *
 * The window is half-open -- `from` inclusive, `to` exclusive -- so consecutive
 * shifts tile without double-counting the boundary, which is the bug a closed
 * interval invites the first time somebody runs two reports back to back.
 */
async function tipsReport({ restaurantId, from, to }) {
  const { rows } = await db.query(
    `SELECT payment_method,
            COUNT(*)::int         AS payments,
            SUM(tip_ves)::BIGINT  AS tips_ves
       FROM payments
      WHERE restaurant_id = $1
        AND status = 'SUCCEEDED'
        AND tip_ves > 0
        AND created_at >= $2
        AND created_at <  $3
      GROUP BY payment_method
      ORDER BY payment_method`,
    [restaurantId, from, to]
  );

  let total = 0n;
  let inTill = 0n;
  let owed = 0n;
  let unclassified = 0n;
  const byMethod = rows.map(row => {
    const tips = BigInt(row.tips_ves);
    total += tips;
    if (IN_TILL_METHODS.has(row.payment_method)) inTill += tips;
    else if (OWED_METHODS.has(row.payment_method)) owed += tips;
    else unclassified += tips;
    return { paymentMethod: row.payment_method, payments: row.payments, tipsVes: tips.toString() };
  });

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    currency: 'VES',
    totalTipsVes: total.toString(),
    // The split that decides what actually has to be handed over. The three
    // always sum to the total, so a figure cannot go missing between them.
    inTillVes: inTill.toString(),
    owedToStaffVes: owed.toString(),
    unclassifiedVes: unclassified.toString(),
    byMethod
  };
}

/**
 * Tips on one bill.
 *
 * Derived, never stored: a second counter on `bills` would be one more thing to
 * keep in step with the ledger, which is precisely what `payment_ledger_drift`
 * exists to catch. The sum is cheap and cannot disagree with itself.
 */
async function tipsForBill({ restaurantId, billId }) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(tip_ves), 0)::BIGINT AS tips_ves
       FROM payments
      WHERE restaurant_id = $1 AND bill_id = $2 AND status = 'SUCCEEDED'`,
    [restaurantId, billId]
  );
  return rows[0].tips_ves;
}

module.exports = { tipsReport, tipsForBill, IN_TILL_METHODS, OWED_METHODS };
