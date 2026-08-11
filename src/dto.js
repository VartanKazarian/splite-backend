const { usdReference } = require('./services/split');

/**
 * The boundary between the database and the wire.
 *
 * PostgreSQL columns are snake_case; the public API is camelCase. Nothing else
 * in the app is allowed to decide that, because when it was decided per-route
 * the API ended up speaking three conventions at once: `bills` returned raw
 * rows, `menu` aliased some columns in SQL and left `created_at` alone, and
 * payments hand-built camelCase objects. A single `Bill` could carry
 * `total_due_ves` and `usdReference` side by side.
 *
 * These mappers are deliberately written out field by field rather than run
 * through a generic snake-to-camel transform. Two reasons:
 *
 *  1. A generic transform makes the wire contract a *derived function of column
 *     names*, so renaming a column silently renames a public field — exactly the
 *     coupling this boundary exists to break.
 *  2. It leaks by default. `{ ...row }` publishes whatever the SELECT happened
 *     to fetch; an allowlist publishes what was intended. `qr_nonce` and
 *     `password_hash` live one careless `SELECT *` away.
 */

/**
 * A DATE column as a plain ISO date.
 *
 * node-pg parses DATE into a JS Date at *local* midnight, so the default
 * serialisation is a full timestamp: "2025-03-06T04:00:00.000Z" on a Caracas
 * server, "2025-03-06T00:00:00.000Z" on a UTC one — one row, two strings,
 * depending on where the process happens to run. A client that then formats it
 * in its own zone can land a day early, and for a BCV value date that is the
 * difference between one published rate and the next.
 */
function isoDate(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    // Read back the same local components pg used to build it. Going through
    // toISOString() here would reintroduce the offset this exists to remove.
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

/** A TIMESTAMPTZ column as an ISO 8601 instant. */
function isoTimestamp(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * A bill, with its derived figures.
 *
 * The outstanding balance is computed rather than stored: two maintained
 * counters for one quantity is the drift the payment ledger exists to remove.
 */
function bill(row) {
  const remainingVes = (BigInt(row.total_due_ves) - BigInt(row.amount_paid_ves)).toString();
  const rate = row.fx_rate_ves_per_unit ?? null;

  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    tableId: row.table_id,
    status: row.status,
    // What the menu quoted, kept for display.
    currency: row.currency,
    totalDue: row.total_due,
    // What Splite settles, always VES céntimos.
    totalDueVes: row.total_due_ves,
    amountPaidVes: row.amount_paid_ves,
    remainingVes,
    fxRateVesPerUnit: rate,
    fxRateSource: row.fx_rate_source ?? null,
    fxValueDate: isoDate(row.fx_value_date),
    calculationVersion: row.calculation_version,
    usdReference: {
      totalDue: usdReference(row.total_due_ves, rate),
      amountPaid: usdReference(row.amount_paid_ves, rate),
      remaining: usdReference(remainingVes, rate)
    },
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * A bill line.
 *
 * Amounts are minor units as digit strings, like every other monetary value on
 * the wire -- a decimal string here would be a second money format for clients
 * to handle, and the point of the contract is that there is one.
 *
 * `productId` is nullable by design: the line survives the product it came
 * from, and `name` is the snapshot taken when it was added, not today's menu.
 */
function billItem(row) {
  return {
    id: row.id,
    billId: row.bill_id,
    productId: row.product_id ?? null,
    name: row.name_snapshot,
    unitPriceMinor: row.unit_price_minor,
    currency: row.currency,
    quantity: row.quantity,
    subtotalMinor: row.subtotal_minor,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * A bill with its lines.
 *
 * Kept separate from `bill` rather than making `items` conditional: a field
 * that is sometimes present is exactly the ambiguity the contract work removed.
 * List endpoints return `bill`, single-bill reads return this, and the two are
 * documented as different schemas.
 */
function billWithItems(row, items = []) {
  return {
    ...bill(row),
    itemCount: items.length,
    items: items.map(billItem)
  };
}

function table(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    name: row.name,
    active: row.active,
    createdAt: isoTimestamp(row.created_at)
  };
}

function product(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    priceMinorUnits: row.price_minor_units,
    currency: row.currency,
    active: row.active,
    createdAt: isoTimestamp(row.created_at),
    updatedAt: isoTimestamp(row.updated_at)
  };
}

/**
 * The public menu's narrower product.
 *
 * A guest scanning a QR is shown what a thing is and what it costs. Whether it
 * is active is implied — inactive products are not listed — and when it was
 * last edited is operational detail that no diner needs.
 */
function publicProduct(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    priceMinorUnits: row.price_minor_units,
    currency: row.currency
  };
}

function menuSettings(row) {
  return {
    id: row.id,
    name: row.name,
    menuCurrency: row.menu_currency
  };
}

module.exports = {
  isoDate, isoTimestamp,
  bill, billItem, billWithItems,
  table, product, publicProduct, menuSettings
};
