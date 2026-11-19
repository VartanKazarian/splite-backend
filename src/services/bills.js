const db = require('../connectors/base');
const { ApiError } = require('../errors');
const inFlight = require('./inFlight');

/**
 * Bills, as staff work on them, where it is more than a single read.
 *
 * Voiding lived in the route (R18): business rules -- nothing paid, nothing
 * being verified -- inside an Express handler, out of reach of any test that
 * did not go through HTTP.
 */

// total_due and currency are what the menu quoted; total_due_ves and
// amount_paid_ves are what Splite settles. The rate is frozen at bill creation.
const BILL_COLUMNS = `id, restaurant_id, table_id, status,
                      total_due, currency,
                      subtotal_minor, vat_bps, vat_minor,
                      service_charge_bps, service_charge_minor,
                      total_due_ves, amount_paid_ves,
                      fx_rate_ves_per_unit, fx_rate_source, fx_value_date,
                      calculation_version, served_by, created_at, updated_at`;

/**
 * Void an open bill nobody has paid anything against.
 *
 * Refused once money has landed (BILL_HAS_PAYMENTS) and while a transfer is
 * still being verified: a diner who declared one has, as far as anyone knows,
 * paid.
 */
async function voidBill({ restaurantId, billId }) {
  return db.withTransaction(async client => {
    // Locked first, then checked: a Pago Móvil declaration takes the same
    // lock (paymentClaims.declareClaim), so a claim cannot slip in between
    // the check and the void. Each statement after the lock reads a fresh
    // snapshot, so a claim committed while we waited is seen.
    const existing = (await client.query(
      'SELECT status, amount_paid_ves FROM bills WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
      [billId, restaurantId]
    )).rows[0];
    if (!existing) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
    if (existing.status !== 'OPEN') {
      throw new ApiError('BILL_NOT_OPEN', `A ${existing.status} bill cannot be voided`, {
        status: existing.status
      });
    }
    if (existing.amount_paid_ves !== '0') {
      throw new ApiError('BILL_HAS_PAYMENTS', 'A bill with payments applied cannot be voided');
    }

    // A diner who declared a transfer has, as far as anyone knows, paid.
    // Voiding the bill under them would turn their money into a claim
    // against a bill that no longer exists.
    const pending = await inFlight.forBill({ restaurantId, billId }, client);
    if (pending.count > 0) {
      throw new ApiError(
        'BILL_HAS_PAYMENTS',
        'A payment on this bill is still being verified; confirm or reject it before voiding',
        { inFlightPayments: pending.count }
      );
    }

    return (await client.query(
      `UPDATE bills SET status = 'VOID'
        WHERE id = $1 AND restaurant_id = $2
      RETURNING ${BILL_COLUMNS}`,
      [billId, restaurantId]
    )).rows[0];
  });
}

module.exports = { BILL_COLUMNS, voidBill };
