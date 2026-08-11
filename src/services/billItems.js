const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { toMinor, parseRate, applyRate } = require('./money');

/**
 * Bill line items, and the totals derived from them.
 *
 * Two rules govern everything here.
 *
 * **A line's price is a snapshot.** It is copied from the product when the line
 * is added and never read from the menu again, so re-pricing, renaming or
 * deactivating a product cannot change a bill that has already been served.
 * The database enforces the shape of that snapshot; this file decides what goes
 * into it.
 *
 * **Totals are derived, never supplied.** Once a bill has items, its
 * `total_due` is the sum of its lines and its `total_due_ves` is that sum at
 * the rate frozen when the bill opened -- *not* at today's rate. Recomputing
 * with a fresh rate would mean adding a coffee silently reprices the whole
 * meal, which is the one thing the frozen rate exists to prevent.
 */

const ITEM_COLUMNS = `id, bill_id, product_id, name_snapshot,
                      unit_price_minor, currency, quantity, subtotal_minor,
                      created_at, updated_at`;

/**
 * Locks the bill and returns it, or explains why it cannot be changed.
 *
 * The lock is what makes two waiters adding items to the same bill serialise
 * rather than both recomputing a total from a stale set of lines.
 */
async function lockOpenBill(client, { restaurantId, billId }) {
  const { rows } = await client.query(
    `SELECT id, status, currency, total_due, total_due_ves, amount_paid_ves,
            fx_rate_ves_per_unit
       FROM bills
      WHERE id = $1 AND restaurant_id = $2
      FOR UPDATE`,
    [billId, restaurantId]
  );

  const bill = rows[0];
  if (!bill) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
  if (bill.status !== 'OPEN') {
    throw new ApiError('BILL_NOT_OPEN', `A ${bill.status} bill cannot be changed`, {
      status: bill.status
    });
  }
  return bill;
}

/**
 * Rewrites the bill's totals from its lines.
 *
 * Returns the updated bill. Runs inside the caller's transaction, with the bill
 * already locked, so the sum it reads cannot move underneath it.
 */
async function recalculateTotals(client, bill) {
  const { rows } = await client.query(
    'SELECT COALESCE(SUM(subtotal_minor), 0)::TEXT AS subtotal FROM bill_items WHERE bill_id = $1',
    [bill.id]
  );
  const subtotal = toMinor(rows[0].subtotal, 'Bill subtotal');

  // The rate frozen when the bill opened. A VES bill carries the identity rate
  // rather than a null, so there is no branch here.
  const scaledRate = parseRate(bill.fx_rate_ves_per_unit ?? '1');
  const totalDueVes = applyRate(subtotal, scaledRate, 'Bill total in VES');

  // CHECK (amount_paid_ves <= total_due_ves) would otherwise raise a 23514 and
  // surface as a 500. Removing a line that somebody has already paid for is a
  // refund, not an edit, so it is refused with something a client can act on.
  const amountPaid = toMinor(bill.amount_paid_ves);
  if (totalDueVes < amountPaid) {
    throw new ApiError(
      'TOTAL_BELOW_AMOUNT_PAID',
      'That change would put the bill total below what has already been paid',
      { amountPaidVes: amountPaid.toString(), proposedTotalVes: totalDueVes.toString() }
    );
  }

  const updated = await client.query(
    `UPDATE bills
        SET total_due = $1, total_due_ves = $2
      WHERE id = $3
    RETURNING id, restaurant_id, table_id, status, total_due, currency,
              total_due_ves, amount_paid_ves, fx_rate_ves_per_unit,
              fx_rate_source, fx_value_date, calculation_version,
              created_at, updated_at`,
    [subtotal.toString(), totalDueVes.toString(), bill.id]
  );
  return updated.rows[0];
}

/**
 * Refuses to itemise a bill that was opened with a manual total.
 *
 * Deriving the total would silently discard the figure the caller supplied, and
 * adding to it would mean the same bill counted two ways. A client that wants
 * line items opens the bill with a total of 0.
 */
function assertItemisable(bill, itemCount) {
  if (itemCount === 0 && toMinor(bill.total_due) > 0n) {
    throw new ApiError(
      'BILL_NOT_ITEMISED',
      'This bill was opened with a fixed total. Open it with a total of 0 to add line items.',
      { totalDue: String(bill.total_due) }
    );
  }
}

async function countItems(client, billId) {
  const { rows } = await client.query(
    'SELECT count(*)::int AS n FROM bill_items WHERE bill_id = $1', [billId]
  );
  return rows[0].n;
}

/** Every line on a bill, oldest first. Tenant-scoped. */
async function listForBill({ restaurantId, billId }) {
  const { rows } = await db.query(
    `SELECT ${ITEM_COLUMNS} FROM bill_items
      WHERE bill_id = $1 AND restaurant_id = $2
      ORDER BY created_at, id`,
    [billId, restaurantId]
  );
  return rows;
}

/**
 * Adds a line, snapshotting the product's name and price.
 *
 * The same product may be added twice: a second round is a second line, not an
 * increment, because the two may have been ordered at different prices.
 */
async function addItem({ restaurantId, billId, productId, quantity }) {
  return db.withTransaction(async client => {
    const bill = await lockOpenBill(client, { restaurantId, billId });
    assertItemisable(bill, await countItems(client, billId));

    // Resolved inside the caller's tenant, so a product id from another
    // restaurant reads as absent rather than being snapshotted onto this bill.
    const { rows } = await client.query(
      'SELECT id, name, price_minor_units, currency, active FROM menu_products WHERE id = $1 AND restaurant_id = $2',
      [productId, restaurantId]
    );
    const product = rows[0];
    if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'Product not found');
    if (!product.active) {
      throw new ApiError('PRODUCT_INACTIVE', 'That product is no longer on the menu', {
        productId: product.id
      });
    }

    // The database enforces this too, through the composite foreign key. Doing
    // it here as well turns a constraint violation into an explicable error.
    if (product.currency !== bill.currency) {
      throw new ApiError(
        'MENU_CURRENCY_MISMATCH',
        `This bill settles a ${bill.currency} menu; that product is priced in ${product.currency}`,
        { billCurrency: bill.currency, productCurrency: product.currency }
      );
    }

    const inserted = await client.query(
      `INSERT INTO bill_items
         (restaurant_id, bill_id, product_id, name_snapshot, unit_price_minor, currency, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${ITEM_COLUMNS}`,
      [restaurantId, billId, product.id, product.name, product.price_minor_units, product.currency, quantity]
    );

    return { item: inserted.rows[0], bill: await recalculateTotals(client, bill) };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

/** Changes a line's quantity. The snapshotted price is never revisited. */
async function updateQuantity({ restaurantId, billId, itemId, quantity }) {
  return db.withTransaction(async client => {
    const bill = await lockOpenBill(client, { restaurantId, billId });

    const { rows } = await client.query(
      `UPDATE bill_items SET quantity = $1
        WHERE id = $2 AND bill_id = $3 AND restaurant_id = $4
      RETURNING ${ITEM_COLUMNS}`,
      [quantity, itemId, billId, restaurantId]
    );
    if (!rows.length) throw new ApiError('BILL_ITEM_NOT_FOUND', 'Line item not found on this bill');

    return { item: rows[0], bill: await recalculateTotals(client, bill) };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

async function removeItem({ restaurantId, billId, itemId }) {
  return db.withTransaction(async client => {
    const bill = await lockOpenBill(client, { restaurantId, billId });

    const { rows } = await client.query(
      'DELETE FROM bill_items WHERE id = $1 AND bill_id = $2 AND restaurant_id = $3 RETURNING id',
      [itemId, billId, restaurantId]
    );
    if (!rows.length) throw new ApiError('BILL_ITEM_NOT_FOUND', 'Line item not found on this bill');

    return { removedId: rows[0].id, bill: await recalculateTotals(client, bill) };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

module.exports = { listForBill, addItem, updateQuantity, removeItem, recalculateTotals };
