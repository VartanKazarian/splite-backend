const db = require('../../../src/connectors/base');

/**
 * Row fixtures for the integration suite.
 *
 * Every fixture is created under a restaurant the test owns, and torn down
 * explicitly. Cascade deletion is not relied on: bills.table_id is
 * ON DELETE RESTRICT, so deleting a restaurant can fail depending on the order
 * Postgres processes the cascade. Deleting children first is deterministic.
 */

async function createRestaurant({ name = 'Integration Test Restaurant', currency = 'VES' } = {}) {
  const { rows } = await db.query(
    'INSERT INTO restaurants (name, currency) VALUES ($1, $2) RETURNING id, currency',
    [name, currency]
  );
  return rows[0];
}

async function createTable(restaurantId, { name = 'T1' } = {}) {
  const { rows } = await db.query(
    'INSERT INTO tables (restaurant_id, name) VALUES ($1, $2) RETURNING id, qr_nonce',
    [restaurantId, name]
  );
  return rows[0];
}

async function createBill({
  restaurantId, tableId, totalDue, amountPaid = 0, currency = 'VES', status = 'OPEN',
  // Settlement is VES. A VES menu converts at identity, which is what every
  // fixture wants unless it is specifically exercising a foreign-currency bill.
  totalDueVes = null, fxRate = '1'
}) {
  const { rows } = await db.query(
    // subtotal_minor mirrors total_due, as the route does when opening a bill
    // with a fixed figure: CHECK (total_due = subtotal + vat + service) must
    // hold on every row, not only on ones the application wrote.
    `INSERT INTO bills (restaurant_id, table_id, total_due, subtotal_minor, currency, status,
                        total_due_ves, amount_paid_ves,
                        fx_rate_ves_per_unit, fx_rate_source, fx_rate_as_of)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, 'IDENTITY', NOW())
     RETURNING id, total_due, currency, status, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit`,
    [
      restaurantId, tableId, String(totalDue), currency, status,
      String(totalDueVes ?? totalDue), String(amountPaid), fxRate
    ]
  );
  return rows[0];
}

async function readBill(billId) {
  const { rows } = await db.query(
    `SELECT id, total_due, currency, status, total_due_ves, amount_paid_ves, fx_rate_ves_per_unit
       FROM bills WHERE id = $1`,
    [billId]
  );
  return rows[0];
}

/** Children before parents; see the note above about ON DELETE RESTRICT. */
async function destroyRestaurant(restaurantId) {
  if (!restaurantId) return;
  for (const sql of [
    // The ledger uses ON DELETE RESTRICT so money cannot vanish with a bill;
    // teardown therefore has to clear it before the bills it references.
    'DELETE FROM payment_transitions WHERE restaurant_id = $1',
    'DELETE FROM payments WHERE restaurant_id = $1',
    'DELETE FROM menu_products WHERE restaurant_id = $1',
    'DELETE FROM idempotency_keys WHERE restaurant_id = $1',
    'DELETE FROM audit_logs WHERE restaurant_id = $1',
    'DELETE FROM refresh_sessions WHERE restaurant_id = $1',
    'DELETE FROM bills WHERE restaurant_id = $1',
    'DELETE FROM tables WHERE restaurant_id = $1',
    'DELETE FROM users WHERE restaurant_id = $1',
    'DELETE FROM restaurants WHERE id = $1'
  ]) {
    await db.query(sql, [restaurantId]);
  }
}

module.exports = { createRestaurant, createTable, createBill, readBill, destroyRestaurant };
