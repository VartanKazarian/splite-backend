/**
 * The order rows are locked in, for every transaction that moves money.
 *
 *   tables -> bills -> payments -> bill_splits -> bill_split_participants
 *
 * Postgres finds a deadlock and kills one side of it, and at the till that
 * side is a 500 on "Confirmar" or on a cash payment. Two transactions can only
 * deadlock if they take the same two locks in opposite orders, so the cure is
 * one order everywhere -- not a retry around each call site.
 *
 * Bill first because the bill is the thing every money path agrees on. The
 * staff split path (`processSplitPayment`) and a guest's claim both start
 * there. Confirming a claim used to start at the *payment* and reach the bill
 * second, so a cashier confirming a transfer while a waiter rang up cash on
 * the same bill could each be holding what the other wanted (R18).
 *
 * A payment's bill is looked up without a lock and then locked: `bill_id` on a
 * payment never changes, so reading it first cannot be stale in a way that
 * matters, and it is the only way to know which bill to take before the
 * payment.
 */

/** Lock one bill, and say whether it exists. */
async function lockBill(client, { restaurantId, billId }) {
  const { rowCount } = await client.query(
    'SELECT 1 FROM bills WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
    [billId, restaurantId]
  );
  return rowCount > 0;
}

/**
 * Lock a payment the right way round: its bill, then it.
 *
 * Returns the payment row with the requested columns, or undefined when there
 * is no such payment in this restaurant -- the caller decides what that means.
 */
async function lockPayment(client, { restaurantId, paymentId, columns = '*' }) {
  const peek = await client.query(
    'SELECT bill_id FROM payments WHERE id = $1 AND restaurant_id = $2',
    [paymentId, restaurantId]
  );
  if (peek.rowCount === 0) return undefined;
  if (peek.rows[0].bill_id) {
    await lockBill(client, { restaurantId, billId: peek.rows[0].bill_id });
  }
  const { rows } = await client.query(
    `SELECT ${columns} FROM payments WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
    [paymentId, restaurantId]
  );
  return rows[0];
}

module.exports = { lockBill, lockPayment };
