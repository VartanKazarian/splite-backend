const db = require('../connectors/base');
const { usdReference } = require('./split');
const config = require('../config');
const { recordPayment } = require('./payments');

// bills.fx_rate_ves_per_unit is NUMERIC(20,6). pg returns NUMERIC as a string
// carrying the column's full scale, so normalising here keeps the reported rate
// identical across every split on a bill.
const RATE_SCALE_DECIMALS = 6;

function formatRate(value) {
  if (value === null || value === undefined) return null;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate.toFixed(RATE_SCALE_DECIMALS) : null;
}

/**
 * Applies a partial payment to a bill. Settlement is always VES céntimos.
 *
 * SELECT ... FOR UPDATE serialises concurrent splits on the same bill, so two
 * diners paying simultaneously cannot both read the same amount_paid_ves. Every
 * clause is tenant-scoped; a bill id from another restaurant reads as 404.
 *
 * Note what this no longer does: fetch an exchange rate. The rate is frozen when
 * the bill is opened, so the payment path has no dependency on BCV at all. An FX
 * outage cannot reach it, and there is no external call anywhere near the row
 * lock.
 */
async function processSplitPayment({
  restaurantId,
  billId,
  amountPaidMinorUnits,
  idempotencyKey = null,
  paymentMethod = 'SPLITE',
  payer = { type: 'STAFF', id: null },
  tendered = null
}) {
  const amount = Number(amountPaidMinorUnits);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const error = new Error('Invalid payment amount');
    error.statusCode = 400;
    throw error;
  }

  // The payment path runs on its own statement budget: several diners paying the
  // same bill serialise on FOR UPDATE, and lock waiting counts toward
  // statement_timeout exactly like execution.
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, restaurant_id, currency, status,
              total_due_ves, amount_paid_ves,
              fx_rate_ves_per_unit, fx_rate_source
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

    // BIGINT arrives from pg as a string; BigInt keeps the arithmetic exact for
    // totals beyond 2^53 céntimos.
    const totalDue = BigInt(bill.total_due_ves);
    const newAmountPaid = BigInt(bill.amount_paid_ves) + BigInt(amount);
    if (newAmountPaid > totalDue) {
      const error = new Error('Payment exceeds remaining bill balance');
      error.statusCode = 409;
      throw error;
    }

    const newStatus = newAmountPaid === totalDue ? 'CLOSED' : 'OPEN';
    await client.query(
      `UPDATE bills
          SET amount_paid_ves = $1, status = $2, updated_at = NOW()
        WHERE id = $3 AND restaurant_id = $4`,
      [newAmountPaid.toString(), newStatus, bill.id, restaurantId]
    );

    // The ledger row is written inside this transaction, alongside the cache it
    // is the source of truth for. If either fails, neither happens.
    const payment = await recordPayment(client, {
      restaurantId,
      billId: bill.id,
      amountVes: amount,
      status: 'SUCCEEDED',
      paymentMethod,
      idempotencyKey,
      payerType: payer?.type ?? 'STAFF',
      payerId: payer?.id ?? null,
      tendered
    });

    const remaining = totalDue - newAmountPaid;
    const fxRate = bill.fx_rate_ves_per_unit ?? null;

    return {
      id: bill.id,
      paymentId: payment.id,
      status: newStatus,
      // Settlement figures, always VES.
      currency: 'VES',
      totalDue: totalDue.toString(),
      amountPaid: newAmountPaid.toString(),
      remaining: remaining.toString(),
      // What the menu quoted, and the rate frozen when the bill was opened.
      displayCurrency: bill.currency,
      fxRate: formatRate(fxRate),
      fxSource: bill.fx_rate_source ?? null,
      // Presentational only.
      usdReference: {
        totalDue: usdReference(totalDue.toString(), fxRate),
        amountPaid: usdReference(newAmountPaid.toString(), fxRate),
        remaining: usdReference(remaining.toString(), fxRate)
      }
    };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

module.exports = { processSplitPayment };
