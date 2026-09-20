const db = require('../../../src/connectors/base');
const { newRif } = require('./rif');

/**
 * Row fixtures for the integration suite.
 *
 * Every fixture is created under a restaurant the test owns, and torn down
 * explicitly. Cascade deletion is not relied on: bills.table_id is
 * ON DELETE RESTRICT, so deleting a restaurant can fail depending on the order
 * Postgres processes the cascade. Deleting children first is deterministic.
 */

/**
 * Con RIF, como los que crea el alta de verdad.
 *
 * No es adorno: sin RIF del emisor no se puede emitir una factura fiscal --
 * `fiscalInvoicing.canIssue` lo exige y `issueForPayment` lo rechaza --, así que
 * un fixture sin él dejaría a media suite fiscal midiendo otra cosa. Una prueba
 * que quiera el caso contrario lo pone a NULL ella misma, que es lo honesto:
 * hace visible que está provocando ese estado.
 */
async function createRestaurant({
  name = 'Integration Test Restaurant', currency = 'VES', rifSource = newRif
} = {}) {
  /*
   * Y si el RIF sorteado ya estuviera cogido, se sortea otro.
   *
   * Nueve dígitos al azar hacen la colisión rarísima, pero «rarísima» es
   * exactamente lo que acaba de costar una vuelta roja, y en una base de
   * desarrollo que no se vacía puede quedar la fila de una corrida anterior.
   * Reintentar convierte la garantía en incondicional: crear un restaurante no
   * puede fallar por el RIF. Sólo se reintenta ESE índice; cualquier otro 23505
   * es un fallo de verdad y sube tal cual.
   */
  for (let attempt = 0; ; attempt++) {
    try {
      const { rows } = await db.query(
        'INSERT INTO restaurants (name, currency, rif) VALUES ($1, $2, $3) RETURNING id, currency, rif',
        [name, currency, rifSource()]
      );
      return rows[0];
    } catch (err) {
      const taken = err.code === '23505' && err.constraint === 'restaurants_rif_unique_idx';
      if (!taken || attempt >= 5) throw err;
    }
  }
}

async function createTable(restaurantId, { name = 'T1' } = {}) {
  const { rows } = await db.query(
    'INSERT INTO tables (restaurant_id, name) VALUES ($1, $2) RETURNING id, name, qr_nonce',
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
    // teardown therefore has to clear it before the bills it references. The
    // C2P side tables RESTRICT payments in turn, so they come first.
    'DELETE FROM c2p_resolution_attempts WHERE restaurant_id = $1',
    'DELETE FROM c2p_charges WHERE restaurant_id = $1',
    'DELETE FROM payment_transitions WHERE restaurant_id = $1',
    // payments RESTRICT split participants, so clear payments first. Then delete
    // bill_splits, which CASCADEs to its participants and items -- deleting the
    // participants directly would trip the deferred "shares sum to basis"
    // constraint, since an active split briefly has basis but no shares.
    'DELETE FROM payments WHERE restaurant_id = $1',
    'DELETE FROM bill_splits WHERE restaurant_id = $1',
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

/**
 * Borra el rastro fiscal de un restaurante **sin apagárselo a nadie más**.
 *
 * Los documentos fiscales son inmutables por trigger, que es lo que los hace
 * servir de prueba, así que limpiarlos exige desactivarlo. Lo que no se puede
 * es hacerlo con `ALTER TABLE ... DISABLE TRIGGER`: **eso es global, no de la
 * sesión**. El runner corre los ficheros en paralelo, así que mientras un
 * teardown lo tiene apagado, otro fichero que comprueba precisamente que la
 * inmutabilidad funciona ve pasar su UPDATE y falla.
 *
 * Medido, no deducido: apagarlo en una conexión deja `pg_trigger.tgenabled` en
 * 'D' para cualquier otra. Así se cayó `fiscalSchema` -- «una factura emitida
 * no se puede modificar ni borrar», con *Missing expected rejection* -- en una
 * vuelta de CI donde no había cambiado nada suyo. El fallo existía desde que
 * hubo dos ficheros haciéndolo; añadir más sólo ensanchó la ventana.
 *
 * `session_replication_role = replica` hace lo mismo **sólo en esta sesión**:
 * en ese modo no disparan los triggers de usuario. Va con `SET LOCAL` dentro
 * de una transacción, así que revierte al COMMIT y no puede quedarse pegado a
 * una conexión del pool que luego preste otra prueba.
 *
 * De paso desactiva las claves ajenas, pero el orden sigue siendo hijos antes
 * que padres: lo que este borrado hace tiene que leerse igual de bien el día
 * que alguien lo copie a un sitio sin esa red.
 */
async function purgeFiscal(restaurantId) {
  if (!restaurantId) return;
  await db.withTransaction(async (client) => {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    for (const sql of [
      // Las entregas por correo son ON DELETE RESTRICT sobre la factura: el
      // rastro de a quién se le mandó su documento no puede desaparecer porque
      // se borre otra cosa.
      'DELETE FROM fiscal_invoice_deliveries WHERE restaurant_id = $1',
      'DELETE FROM fiscal_invoice_lines WHERE restaurant_id = $1',
      'DELETE FROM fiscal_invoice_taxes WHERE restaurant_id = $1',
      'DELETE FROM fiscal_invoices WHERE restaurant_id = $1',
      'DELETE FROM fiscal_invoice_requests WHERE restaurant_id = $1',
      'DELETE FROM fiscal_counters WHERE restaurant_id = $1',
      'DELETE FROM fiscal_series WHERE restaurant_id = $1'
    ]) {
      await client.query(sql, [restaurantId]);
    }
  });
}

module.exports = {
  createRestaurant, createTable, createBill, readBill, destroyRestaurant, purgeFiscal
};
