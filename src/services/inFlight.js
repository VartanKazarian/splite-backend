const db = require('../connectors/base');

/**
 * Money that has been declared or started but not yet settled.
 *
 * A Pago Móvil claim is declared *after* the diner's bank has already sent the
 * transfer, so Splite cannot refuse it without losing track of money that has
 * moved. What it can do is make the in-flight amount visible to everyone else
 * at the table *before* they transfer, so the second diner sees "40,00 Bs en
 * verificación" instead of a balance that still looks unpaid.
 *
 * The same three statuses the split void guard has always used
 * (services/splits.js): a payment in any of them may still settle.
 */
const IN_FLIGHT_STATUSES = ['PENDING', 'IN_DOUBT', 'AMBIGUOUS'];

/**
 * Totals of in-flight payments on one bill, overall and per split share.
 *
 * Takes a client so callers inside a transaction read under their own locks;
 * defaults to the pool for read-only views.
 *
 * @returns {{ totalVes: bigint, count: number, byShare: Map<string, bigint> }}
 */
async function forBill({ restaurantId, billId }, client = db) {
  const { rows } = await client.query(
    `SELECT split_participant_id, SUM(amount_ves)::TEXT AS amount_ves, COUNT(*)::INT AS count
       FROM payments
      WHERE restaurant_id = $1 AND bill_id = $2 AND status = ANY($3::text[])
      GROUP BY split_participant_id`,
    [restaurantId, billId, IN_FLIGHT_STATUSES]
  );

  let totalVes = 0n;
  let count = 0;
  const byShare = new Map();
  for (const row of rows) {
    const amount = BigInt(row.amount_ves);
    totalVes += amount;
    count += row.count;
    if (row.split_participant_id) byShare.set(row.split_participant_id, amount);
  }
  return { totalVes, count, byShare };
}

/** What is left to pay once in-flight money is counted, never below zero. */
function available(remainingVes, pendingVes) {
  const left = BigInt(remainingVes) - BigInt(pendingVes);
  return left > 0n ? left : 0n;
}

module.exports = { IN_FLIGHT_STATUSES, forBill, available };
