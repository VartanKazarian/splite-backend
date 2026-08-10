const db = require('../connectors/base');
const { usdReference } = require('./split');
const { logger } = require('../connectors/logger');
const config = require('../config');

// bills.fx_rate is NUMERIC(20,6). pg returns NUMERIC as a string carrying the
// column's full scale ('756.710000'), while a rate that has just been resolved
// upstream arrives as a JS number (756.71). Returning whichever happened to be
// in hand meant the payment that locked the rate reported a different string
// from every later split on the same bill, for the same underlying rate.
// Normalising both to the column's scale keeps the response stable for the
// lifetime of the bill.
const RATE_SCALE_DECIMALS = 6;

function formatRate(value) {
  if (value === null || value === undefined) return null;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate.toFixed(RATE_SCALE_DECIMALS) : null;
}

/**
 * Applies a partial payment to a bill. Settlement is always VES minor units.
 *
 * SELECT ... FOR UPDATE serialises concurrent splits on the same bill, so two
 * diners paying simultaneously cannot both read the same amount_paid. Every
 * clause is tenant-scoped; a bill id from another restaurant reads as 404.
 */
async function processSplitPayment({ restaurantId, billId, amountPaidMinorUnits, getRate }) {
  const amount = Number(amountPaidMinorUnits);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    const error = new Error('Invalid payment amount');
    error.statusCode = 400;
    throw error;
  }

  // Resolved before BEGIN so a network call never happens while holding a row
  // lock, and only when this bill has no rate yet — an FX outage must not stop
  // later splits on a bill whose rate is already locked.
  const pending = await resolvePendingRate({ restaurantId, billId, getRate });

  // The payment path runs on its own statement budget. The work itself is a
  // locked read and two writes, but several diners paying the same bill at once
  // serialise on SELECT ... FOR UPDATE, and time spent waiting for that lock
  // counts toward statement_timeout just like time spent executing.
  //
  // Note what is deliberately *not* inside this transaction: resolving the FX
  // rate above. A slow external call must never be made while holding a row
  // lock, which is why no provider timeout needs to be accommodated here.
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, restaurant_id, total_due, amount_paid, status, currency, fx_rate, fx_source
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

    // BIGINT arrives from pg as a string; BigInt keeps the arithmetic exact
    // for totals beyond 2^53 céntimos.
    const totalDue = BigInt(bill.total_due);
    const newAmountPaid = BigInt(bill.amount_paid) + BigInt(amount);
    if (newAmountPaid > totalDue) {
      const error = new Error('Payment exceeds remaining bill balance');
      error.statusCode = 409;
      throw error;
    }

    // Lock the display rate on the first payment. A concurrent first payment
    // may have won the race, in which case its rate stands.
    // Nullish rather than strict: pg sends null, a caller may send undefined.
    const existingRate = bill.fx_rate ?? null;
    const lockRate = existingRate === null && pending !== null;

    const newStatus = newAmountPaid === totalDue ? 'CLOSED' : 'OPEN';
    await client.query(
      `UPDATE bills
          SET amount_paid = $1,
              status = $2,
              updated_at = NOW(),
              fx_rate = COALESCE(fx_rate, $5),
              fx_source = COALESCE(fx_source, $6),
              fx_locked_at = CASE WHEN fx_rate IS NULL AND $5::NUMERIC IS NOT NULL THEN NOW() ELSE fx_locked_at END
        WHERE id = $3 AND restaurant_id = $4`,
      [newAmountPaid.toString(), newStatus, bill.id, restaurantId, lockRate ? pending.rate : null, lockRate ? pending.source : null]
    );

    // Read back the locked rate to ensure consistency across concurrent requests
    const { rows: updatedRows } = await client.query(
      `SELECT fx_rate, fx_source FROM bills WHERE id = $1 AND restaurant_id = $2`,
      [billId, restaurantId]
    );

    const lockedBill = updatedRows[0];
    const fxRate = lockedBill.fx_rate ?? null;
    const fxSource = lockedBill.fx_source ?? null;

    const remaining = totalDue - newAmountPaid;
    return {
      id: bill.id,
      status: newStatus,
      currency: 'VES',
      totalDue: totalDue.toString(),
      amountPaid: newAmountPaid.toString(),
      remaining: remaining.toString(),
      // Presentational only. Null when no verified rate was available.
      fxRate: formatRate(fxRate),
      fxSource,
      usdReference: {
        totalDue: usdReference(totalDue.toString(), fxRate),
        amountPaid: usdReference(newAmountPaid.toString(), fxRate),
        remaining: usdReference(remaining.toString(), fxRate)
      }
    };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

async function resolvePendingRate({ restaurantId, billId, getRate }) {
  if (typeof getRate !== 'function') return null;
  try {
    const { rows } = await db.query(
      'SELECT fx_rate FROM bills WHERE id = $1 AND restaurant_id = $2',
      [billId, restaurantId]
    );
    if (!rows.length || (rows[0].fx_rate ?? null) !== null) return null;
    return await getRate();
  } catch (err) {
    // The USD reference is optional; never let it interrupt a payment.
    logger.warn({ event: 'FX_LOOKUP_SKIPPED', billId, err }, 'Rate lookup skipped; payment continues');
    return null;
  }
}

module.exports = { processSplitPayment };
