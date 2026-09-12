const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { toMinor, parseRate, applyRate, applyBps } = require('./money');
const { logger } = require('../connectors/logger');

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
                      tax_category, vat_bps,
                      created_at, updated_at`;

/**
 * La alícuota que de verdad le toca a un producto, ya resuelta.
 *
 * El producto guarda NULL cuando va a la general del restaurante, porque una
 * columna llena de copias del mismo número se desincroniza a la primera. Aquí
 * se resuelve una sola vez, al añadir la línea, y lo que se congela en la línea
 * es el número: el restaurante puede cambiar su tasa mañana y esta cena no.
 *
 * Lo que no está gravado va a cero pase lo que pase. Un exento con una alícuota
 * al lado no existe -- la base de datos tampoco lo admite.
 */
function resolveLineTax(product, bill) {
  const category = product.tax_category ?? 'TAXABLE';
  if (category !== 'TAXABLE') return { category, vatBps: 0 };
  return { category, vatBps: product.vat_bps ?? bill.vat_bps ?? 0 };
}

/**
 * Locks the bill and returns it, or explains why it cannot be changed.
 *
 * The lock is what makes two waiters adding items to the same bill serialise
 * rather than both recomputing a total from a stale set of lines.
 */
async function lockOpenBill(client, { restaurantId, billId }) {
  const { rows } = await client.query(
    `SELECT id, status, currency, total_due, total_due_ves, amount_paid_ves,
            fx_rate_ves_per_unit, service_charge_bps, vat_bps
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
 * Las bases imponibles de una cuenta, una por alícuota.
 *
 * Vive fuera de `recalculateTotals` porque tiene un segundo lector: el recibo
 * imprime el mismo desglose que la cuenta declara, y si cada uno lo calculara
 * por su cuenta acabarían discrepando en el céntimo del redondeo -- que es
 * justo el céntimo que hace que un recibo no cuadre con su cuenta.
 */
const TAX_GROUPS_SQL = `SELECT COALESCE(vat_bps, 0) AS vat_bps,
            COALESCE(SUM(subtotal_minor), 0)::TEXT AS base
       FROM bill_items
      WHERE bill_id = $1
      GROUP BY COALESCE(vat_bps, 0)
      ORDER BY COALESCE(vat_bps, 0)`;

/**
 * Suma las bases y aplica a cada una su alícuota.
 *
 * Una vez por grupo y no una por línea, para que el total no dependa de en
 * cuántos renglones se partió lo mismo. Devuelve además los grupos, que es lo
 * que un documento -- recibo o factura -- tiene que imprimir.
 */
function summariseTaxGroups(rows) {
  const groups = [];
  let subtotal = 0n;
  let vat = 0n;
  for (const row of rows) {
    const base = toMinor(row.base, 'Taxable base');
    const vatBps = Number(row.vat_bps);
    const vatMinor = applyBps(base, vatBps, 'IVA');
    subtotal += base;
    vat += vatMinor;
    groups.push({ vatBps, baseMinor: base, vatMinor });
  }
  return { groups, subtotal, vat };
}

/**
 * Rewrites the bill's totals from its lines.
 *
 * Returns the updated bill. Runs inside the caller's transaction, with the bill
 * already locked, so the sum it reads cannot move underneath it.
 */
async function recalculateTotals(client, bill) {
  /*
   * El IVA se calcula **por alícuota**, no por línea ni de una vez sobre el
   * subtotal.
   *
   * Por alícuota y no por línea porque así es como se declara: un documento
   * fiscal lleva una base imponible y un IVA por cada tasa, no uno por renglón.
   * Redondear una vez por grupo en vez de una por línea evita además que el
   * total dependa de en cuántos renglones se partió lo mismo.
   *
   * Y esto **no mueve ni un céntimo de lo ya calculado**: mientras todo vaya a
   * la misma tasa -- que es lo único que el modelo sabía expresar hasta ahora --
   * hay un solo grupo, el subtotal del grupo es el subtotal de la cuenta, y la
   * operación es idéntica a la de antes. Hay una prueba que lo fija.
   */
  const { rows } = await client.query(TAX_GROUPS_SQL, [bill.id]);
  const { subtotal, vat } = summariseTaxGroups(rows);

  // El servicio sigue tomándose sobre el subtotal entero y sin componer con el
  // IVA: gravar subtotal + servicio inflaría el impuesto en todas las cuentas.
  const serviceCharge = applyBps(subtotal, bill.service_charge_bps ?? 0, 'Service charge');
  const total = subtotal + vat + serviceCharge;

  // The rate frozen when the bill opened. A VES bill carries the identity rate
  // rather than a null, so there is no branch here.
  const scaledRate = parseRate(bill.fx_rate_ves_per_unit ?? '1');
  const totalDueVes = applyRate(total, scaledRate, 'Bill total in VES');

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
        SET subtotal_minor = $1, vat_minor = $2, service_charge_minor = $3,
            total_due = $4, total_due_ves = $5
      WHERE id = $6
    RETURNING id, restaurant_id, table_id, status, total_due, currency,
              subtotal_minor, vat_bps, vat_minor,
              service_charge_bps, service_charge_minor,
              total_due_ves, amount_paid_ves, fx_rate_ves_per_unit,
              fx_rate_source, fx_value_date, calculation_version,
              created_at, updated_at`,
    [
      subtotal.toString(), vat.toString(), serviceCharge.toString(),
      total.toString(), totalDueVes.toString(), bill.id
    ]
  );

  // A split was agreed against the old total, so it no longer governs this
  // bill. Marked here rather than in each of the four callers because this is
  // the one place an item edit can change what is owed -- a caller that forgot
  // would leave the table settling a plan that no longer adds up, which is the
  // failure this exists to prevent. Only when the figure actually moved: an
  // edit that leaves the total alone leaves the agreement standing.
  if (totalDueVes !== toMinor(bill.total_due_ves)) {
    await markSplitsStale(client, bill.id);
  }

  return updated.rows[0];
}

/**
 * Retires any live split on a bill whose total has changed.
 *
 * STALE rather than recomputed: silently rewriting what a group agreed to is
 * worse than telling them it changed, and a share somebody has already paid
 * cannot move. Money already attributed stays attributed -- it is on the bill's
 * ledger, and `bills.amount_paid_ves` is untouched by this. The group agrees a
 * fresh split on the new total; the partial unique index allows it precisely
 * because the stale one is no longer ACTIVE.
 */
async function markSplitsStale(client, billId) {
  const { rowCount } = await client.query(
    `UPDATE bill_splits SET status = 'STALE'
      WHERE bill_id = $1 AND status = 'ACTIVE'`,
    [billId]
  );
  if (rowCount) {
    logger.info(
      { event: 'BILL_SPLIT_STALE', billId, splits: rowCount },
      'Bill total changed; its split no longer governs and must be re-agreed'
    );
  }
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
      `SELECT id, name, price_minor_units, currency, active, tax_category, vat_bps
         FROM menu_products WHERE id = $1 AND restaurant_id = $2`,
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

    const tax = resolveLineTax(product, bill);

    const inserted = await client.query(
      `INSERT INTO bill_items
         (restaurant_id, bill_id, product_id, name_snapshot, unit_price_minor, currency, quantity,
          tax_category, vat_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${ITEM_COLUMNS}`,
      [restaurantId, billId, product.id, product.name, product.price_minor_units, product.currency,
        quantity, tax.category, tax.vatBps]
    );

    return { item: inserted.rows[0], bill: await recalculateTotals(client, bill) };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

/**
 * Adds several lines in one transaction, recalculating the total once.
 *
 * An order is usually more than one thing, and calling addItem in a loop would
 * take the bill lock and recompute the total once per line -- and leave half an
 * order behind if the third one failed. Either the whole order lands or none of
 * it does.
 *
 * The caller passes an already-locked bill, because opening one requires an FX
 * snapshot that must not happen inside a transaction.
 */
/**
 * `guestOrderId` ata las líneas al pedido que las trajo, cuando vienen de uno.
 * Opcional y por defecto nulo: casi todas las líneas las pone el panel, y ésas
 * no pertenecen a ningún pedido.
 */
async function addItemsInTransaction(client, { restaurantId, bill, items, guestOrderId = null }) {
  assertItemisable(bill, await countItems(client, bill.id));

  const added = [];
  for (const line of items) {
    const { rows } = await client.query(
      `SELECT id, name, price_minor_units, currency, active, tax_category, vat_bps
         FROM menu_products WHERE id = $1 AND restaurant_id = $2`,
      [line.productId, restaurantId]
    );
    const product = rows[0];
    if (!product) {
      throw new ApiError('PRODUCT_NOT_FOUND', 'Product not found', { productId: line.productId });
    }
    if (!product.active) {
      throw new ApiError('PRODUCT_INACTIVE', `${product.name} is no longer on the menu`, {
        productId: product.id
      });
    }
    if (product.currency !== bill.currency) {
      throw new ApiError(
        'MENU_CURRENCY_MISMATCH',
        `This bill settles a ${bill.currency} menu; ${product.name} is priced in ${product.currency}`,
        { billCurrency: bill.currency, productCurrency: product.currency }
      );
    }

    const tax = resolveLineTax(product, bill);

    const inserted = await client.query(
      `INSERT INTO bill_items
         (restaurant_id, bill_id, product_id, name_snapshot, unit_price_minor, currency, quantity,
          guest_order_id, tax_category, vat_bps)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${ITEM_COLUMNS}`,
      [restaurantId, bill.id, product.id, product.name, product.price_minor_units,
        product.currency, line.quantity, guestOrderId, tax.category, tax.vatBps]
    );
    added.push(inserted.rows[0]);
  }

  return { added, bill: await recalculateTotals(client, bill) };
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

module.exports = {
  listForBill, addItem, addItemsInTransaction, updateQuantity, removeItem,
  recalculateTotals, lockOpenBill,
  TAX_GROUPS_SQL, summariseTaxGroups
};
