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

async function createBill({ restaurantId, tableId, totalDue, amountPaid = 0, currency = 'VES', status = 'OPEN' }) {
  const { rows } = await db.query(
    `INSERT INTO bills (restaurant_id, table_id, total_due, amount_paid, currency, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, total_due, amount_paid, currency, status`,
    [restaurantId, tableId, String(totalDue), String(amountPaid), currency, status]
  );
  return rows[0];
}

async function readBill(billId) {
  const { rows } = await db.query(
    'SELECT id, total_due, amount_paid, currency, status FROM bills WHERE id = $1',
    [billId]
  );
  return rows[0];
}

/** Children before parents; see the note above about ON DELETE RESTRICT. */
async function destroyRestaurant(restaurantId) {
  if (!restaurantId) return;
  for (const sql of [
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
