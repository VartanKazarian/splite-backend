const db = require('../connectors/base');
const { ApiError } = require('../errors');
const { usdReference } = require('./split');
const config = require('../config');
const { recordPayment } = require('./payments');

// bills.fx_rate_ves_per_unit is NUMERIC(20,8) — the precision BCV publishes.
// pg returns NUMERIC as a string carrying the column's full scale, so
// normalising here keeps the reported rate identical across every split.
const RATE_SCALE_DECIMALS = 8;

/**
 * The payment amount, as an exact BigInt, or null if it is not one.
 *
 * A JSON number beyond 2^53 has already lost precision by the time it arrives,
 * so it is refused rather than banked as whatever it rounded to. A digit string
 * is exact at any size the BIGINT column can hold, which is the whole reason
 * amounts cross the wire as strings.
 */
function toPaymentAmount(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  let amount;
  try {
    amount = BigInt(value);
  } catch {
    return null; // non-integer, or not a number at all
  }
  return amount > 0n ? amount : null;
}

function formatRate(value) {
  if (value === null || value === undefined) return null;

  // Pad the digits pg actually returned rather than round-tripping through a
  // double. NUMERIC(20,8) can carry more significant digits than a double holds
  // exactly, and the point of storing the published rate is that it stays the
  // published rate.
  const text = String(value).trim();
  const decimal = /^(-?\d+)(?:\.(\d*))?$/.exec(text);
  if (decimal) {
    const [, whole, fraction = ''] = decimal;
    return `${whole}.${(fraction + '0'.repeat(RATE_SCALE_DECIMALS)).slice(0, RATE_SCALE_DECIMALS)}`;
  }

  // Exponential notation and anything else: fall back rather than return junk.
  const rate = Number(text);
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
  const amount = toPaymentAmount(amountPaidMinorUnits);
  if (amount === null) {
    throw new ApiError('INVALID_AMOUNT', 'Invalid payment amount');
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
      throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
    }
    if (bill.status !== 'OPEN') {
      throw new ApiError(
        'BILL_NOT_OPEN',
        bill.status === 'CLOSED' ? 'Bill is already fully paid' : 'Bill is not open',
        { status: bill.status }
      );
    }

    // BIGINT arrives from pg as a string; BigInt keeps the arithmetic exact for
    // totals beyond 2^53 céntimos.
    const totalDue = BigInt(bill.total_due_ves);
    const newAmountPaid = BigInt(bill.amount_paid_ves) + amount;
    if (newAmountPaid > totalDue) {
      throw new ApiError('PAYMENT_EXCEEDS_BALANCE', 'Payment exceeds remaining bill balance', {
        remainingVes: (totalDue - BigInt(bill.amount_paid_ves)).toString()
      });
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
