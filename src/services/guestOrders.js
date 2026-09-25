const db = require('../connectors/base');
const config = require('../config');
const billItems = require('./billItems');
const { snapshotFx } = require('./billOpen');
const { assertMayOpenBills } = require('./subscriptionGate');
const { ApiError } = require('../errors');

/**
 * Pedir desde la mesa.
 *
 * Un comensal escanea el QR, mira la carta y manda "dos tequeños y una
 * cachapa". Las líneas entran en la cuenta en el acto, con las mismas
 * validaciones que las de un mesero -- `addItemsInTransaction` comprueba que
 * el producto existe en *este* restaurante, que sigue activo y que su moneda
 * es la de la cuenta -- y con el mismo recálculo de totales dentro de la misma
 * transacción.
 *
 * **Lo que el cliente no elige.** Ni la mesa ni el restaurante viajan en el
 * cuerpo: salen de la sesión de invitado, que se creó verificando la firma del
 * QR. Un comensal no puede pedir para la mesa de al lado ni para otro local,
 * porque no hay ningún campo donde decirlo.
 *
 * **Abrir cuenta es parte de pedir.** Si la mesa está libre, el primer pedido
 * la abre, igual que cuando un mesero toma nota en una mesa vacía. Sin esto, el
 * comensal que se sienta y pide antes de que nadie se acerque recibiría un
 * error que no puede resolver.
 *
 * `served_by` se queda en NULL a propósito: no lo abrió nadie de la casa, y
 * poner ahí un nombre movería propinas hacia quien no tomó esa nota. La
 * corrección existe y es `PATCH /bills/:id/server`.
 */
async function placeOrder({ restaurantId, tableId, guestSessionId = null, items }) {
  // Fuera de la transacción, como en el camino del mesero: `snapshotFx` puede
  // salir a la red a buscar la tasa, y una llamada lenta con la fila de la mesa
  // bloqueada retiene el bloqueo durante toda la espera.
  const existing = await db.query(
    "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
    [restaurantId, tableId]
  );

  let menuCurrency = null;
  let vatBps = 0;
  let serviceChargeBps = 0;
  let fx = null;
  if (!existing.rows.length) {
    const restaurant = await db.query(
      'SELECT menu_currency, vat_bps, service_charge_bps FROM restaurants WHERE id = $1',
      [restaurantId]
    );
    menuCurrency = restaurant.rows[0]?.menu_currency ?? 'VES';
    vatBps = restaurant.rows[0]?.vat_bps ?? 0;
    serviceChargeBps = restaurant.rows[0]?.service_charge_bps ?? 0;
    fx = await snapshotFx(menuCurrency, '0');
  }

  return db.withTransaction(async client => {
    const table = await client.query(
      'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true FOR UPDATE',
      [tableId, restaurantId]
    );
    if (!table.rows.length) throw new ApiError('TABLE_NOT_FOUND', 'Table not found');

    let opened = false;
    let billId = existing.rows[0]?.id;

    if (!billId) {
      // Suspendido desde la consola: el pedido no abre una cuenta nueva. Una
      // mesa que ya tenía cuenta sigue pidiendo y pagando.
      await assertMayOpenBills(client, restaurantId);
      const created = await client.query(
        `INSERT INTO bills (restaurant_id, table_id, total_due, subtotal_minor, currency,
                            vat_bps, service_charge_bps,
                            total_due_ves, fx_rate_ves_per_unit, fx_rate_source,
                            fx_value_date, fx_rate_as_of)
         VALUES ($1, $2, 0, 0, $3, $4, $5, 0, $6, $7, $8, NOW())
         RETURNING id`,
        [restaurantId, tableId, menuCurrency, vatBps, serviceChargeBps,
          fx.rate, fx.source, fx.valueDate]
      );
      billId = created.rows[0].id;
      opened = true;
    }

    // El pedido se graba antes que las líneas porque las líneas lo apuntan. Y
    // la cuenta se bloquea antes de tocar nada: dos comensales de la misma mesa
    // pidiendo a la vez se serializan en vez de recalcular el total cada uno
    // sobre un conjunto de líneas que el otro ya cambió.
    const bill = await billItems.lockOpenBill(client, { restaurantId, billId });

    const order = await client.query(
      `INSERT INTO guest_orders (restaurant_id, table_id, guest_session_id, bill_id, line_count)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [restaurantId, tableId, guestSessionId, billId, items.length]
    );

    const { added, bill: updated } = await billItems.addItemsInTransaction(client, {
      restaurantId, bill, items, guestOrderId: order.rows[0].id
    });

    return {
      orderId: order.rows[0].id,
      createdAt: order.rows[0].created_at,
      opened,
      bill: updated,
      added
    };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

/**
 * Los pedidos que la sala todavía no ha mirado.
 *
 * Con sus líneas, porque un aviso que dice "la Mesa 4 pidió tres cosas" y no
 * cuáles obliga a abrir la mesa para saber si hay que ir a la cocina. Se leen
 * de `bill_items` por `guest_order_id`, así que una línea que un mesero haya
 * quitado desaparece también de aquí -- que es lo correcto: ya no se debe, y
 * nadie tiene que prepararla.
 *
 * `line_count` se guarda aparte precisamente por eso: dice cuántas se pidieron,
 * frente a las que quedan.
 */
async function listPending({ restaurantId, limit = 50 }) {
  const { rows } = await db.query(
    `SELECT o.id, o.table_id, o.bill_id, o.line_count, o.created_at,
            t.name AS table_name,
            -- Quién tiene atribuida la cuenta, que en un pedido por QR suele
            -- ser nadie: la abrió el comensal. Va aquí para que la bandeja
            -- pueda ofrecer "lo atiendo yo" sólo cuando de verdad falta.
            b.served_by AS served_by,
            COALESCE(
              json_agg(
                json_build_object(
                  'name', i.name_snapshot,
                  'quantity', i.quantity,
                  'subtotalMinor', i.subtotal_minor::text
                ) ORDER BY i.created_at
              ) FILTER (WHERE i.id IS NOT NULL),
              '[]'
            ) AS items
       FROM guest_orders o
       JOIN tables t ON t.id = o.table_id AND t.restaurant_id = o.restaurant_id
       LEFT JOIN bills b ON b.id = o.bill_id AND b.restaurant_id = o.restaurant_id
       LEFT JOIN bill_items i ON i.guest_order_id = o.id
      WHERE o.restaurant_id = $1 AND o.acknowledged_at IS NULL
      GROUP BY o.id, t.name, b.served_by
      ORDER BY o.created_at ASC
      LIMIT $2`,
    [restaurantId, limit]
  );
  return rows;
}

/** Cuántos esperan. El panel lo pide cada pocos segundos; una lista entera no. */
async function pendingSummary({ restaurantId }) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS pending, min(created_at) AS oldest
       FROM guest_orders
      WHERE restaurant_id = $1 AND acknowledged_at IS NULL`,
    [restaurantId]
  );
  const { pending, oldest } = rows[0];
  return {
    pending,
    oldestPendingAt: oldest ? new Date(oldest).toISOString() : null,
    // Calculado aquí y no en el cliente, por lo mismo que la antigüedad de una
    // cuenta: un navegador con el reloj mal puesto convierte un pedido de hace
    // un minuto en uno de hace un día.
    oldestPendingAgeSeconds: oldest
      ? Math.max(0, Math.floor((Date.now() - new Date(oldest).getTime()) / 1000))
      : null
  };
}

/**
 * Dar un pedido por visto.
 *
 * Idempotente: darlo por visto dos veces no es un error ni reescribe quién lo
 * vio primero. Dos meseros tocando el mismo aviso a la vez es lo normal, y el
 * segundo no debería llevarse un fallo por llegar tarde.
 */
async function acknowledge({ restaurantId, orderId, userId }) {
  const { rows } = await db.query(
    `UPDATE guest_orders
        SET acknowledged_at = NOW(), acknowledged_by = $3
      WHERE id = $1 AND restaurant_id = $2 AND acknowledged_at IS NULL
      RETURNING id, acknowledged_at`,
    [orderId, restaurantId, userId]
  );
  if (rows.length) return { id: rows[0].id, acknowledgedAt: rows[0].acknowledged_at, changed: true };

  const existing = await db.query(
    'SELECT id, acknowledged_at FROM guest_orders WHERE id = $1 AND restaurant_id = $2',
    [orderId, restaurantId]
  );
  if (!existing.rows.length) throw new ApiError('GUEST_ORDER_NOT_FOUND', 'Order not found');
  return {
    id: existing.rows[0].id,
    acknowledgedAt: existing.rows[0].acknowledged_at,
    changed: false
  };
}

module.exports = { placeOrder, listPending, pendingSummary, acknowledge };
