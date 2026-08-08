const db = require('../connectors/base');

/**
 * Applies a partial payment to a bill.
 *
 * SELECT ... FOR UPDATE serialises concurrent splits on the same bill, so two
 * diners paying simultaneously cannot both read the same amount_paid. Every
 * clause is tenant-scoped; a bill id from another restaurant reads as 404.
 */
async function processSplitPayment({ restaurantId, billId, amountPaidMinorUnits, currency }) {
  const amount = Number(amountPaidMinorUnits);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const error = new Error('Invalid payment amount');
    error.statusCode = 400;
    throw error;
  }

  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, restaurant_id, total_due, amount_paid, status, currency
         FROM bills
        WHERE id = $1 AND restaurant_id = $2
        FOR UPDATE`,
      [billId, restaurantId]
    );

    const bill = rows[0];
    if (!bill) {
      const error = new Error('Bill not found');
      error.statusCode = 404;
      throw error;
    }
    if (bill.status !== 'OPEN') {
      const error = new Error(bill.status === 'CLOSED' ? 'Bill is already fully paid' : 'Bill is not open');
      error.statusCode = 409;
      throw error;
    }
    if (currency && currency !== bill.currency) {
      const error = new Error(`Payment currency must match the bill currency (${bill.currency})`);
      error.statusCode = 409;
      throw error;
    }

    // BIGINT arrives from pg as a string; BigInt keeps the arithmetic exact
    // for totals beyond 2^53 minor units.
    const totalDue = BigInt(bill.total_due);
    const newAmountPaid = BigInt(bill.amount_paid) + BigInt(amount);
    if (newAmountPaid > totalDue) {
      const error = new Error('Payment exceeds remaining bill balance');
      error.statusCode = 409;
      throw error;
    }

    const newStatus = newAmountPaid === totalDue ? 'CLOSED' : 'OPEN';
    await client.query(
      `UPDATE bills
          SET amount_paid = $1, status = $2, updated_at = NOW()
        WHERE id = $3 AND restaurant_id = $4`,
      [newAmountPaid.toString(), newStatus, bill.id, restaurantId]
    );

    return {
      id: bill.id,
      status: newStatus,
      totalDue: totalDue.toString(),
      amountPaid: newAmountPaid.toString(),
      remaining: (totalDue - newAmountPaid).toString(),
      currency: bill.currency
    };
  });
}

module.exports = { processSplitPayment };
