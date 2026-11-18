const db = require('../connectors/base');
const guestBillBinding = require('./guestBillBinding');
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
const STATUS = Object.freeze({ PLACED: 'PLACED', HELD: 'HELD', REJECTED: 'REJECTED' });

async function placeOrder({ restaurantId, tableId, guestSessionId = null, items, note = null }) {
  if (guestSessionId) {
    const gate = await approvalGate({ restaurantId, sessionId: guestSessionId });
    if (gate.rejected) {
      throw new ApiError('GUEST_ORDERS_BLOCKED',
        'The staff declined an order from this phone; ask your waiter or scan the table again');
    }
    if (gate.needsApproval) return holdOrder({ restaurantId, tableId, guestSessionId, items, note });
  }
  return commitOrder({ restaurantId, tableId, guestSessionId, items, note });
}

/**
 * Las líneas a la cuenta: el camino de siempre, y el de un pedido retenido
 * cuando la sala lo aprueba (`heldOrderId`, `decidedBy`). En ese caso el pedido
 * ya existe y no se crea otro: se marca como hecho, visto y aprobado, y la
 * sesión queda aprobada para lo que pida después.
 */
async function commitOrder({
  restaurantId, tableId, guestSessionId = null, items, note = null,
  heldOrderId = null, decidedBy = null
}) {
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
    let billId = null;

    // Qué cuenta es la de esta sesión, bajo el bloqueo de la mesa. Una sesión
    // atada a una cuenta que ya se cerró no pide sobre la de los siguientes ni
    // abre otra: tiene que volver a escanear. Ver services/guestBillBinding.js.
    if (guestSessionId) {
      const found = await guestBillBinding.billForSession(
        { restaurantId, tableId, sessionId: guestSessionId }, client);
      if (found.billId) {
        billId = found.billId;
      } else if (found.reason !== guestBillBinding.REASONS.NO_OPEN_BILL) {
        throw new ApiError('OPEN_BILL_NOT_FOUND', 'This session\'s bill has ended; scan the table again',
          { reason: found.reason });
      }
    } else {
      const open = await client.query(
        "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
        [restaurantId, tableId]
      );
      billId = open.rows[0]?.id ?? null;
    }

    if (!billId) {
      // Se leyó fuera de la transacción que había una cuenta, y ya no: sin la
      // tasa preparada no se puede abrir una. Que lo reintente el comensal.
      if (!fx) throw new ApiError('OPEN_BILL_NOT_FOUND', 'The table\'s bill just closed; try again');
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
      // El comensal que abre la cuenta con su pedido queda atado a ella.
      if (guestSessionId) {
        await guestBillBinding.bindSession({ restaurantId, sessionId: guestSessionId, billId }, client);
      }
    }

    // El pedido se graba antes que las líneas porque las líneas lo apuntan. Y
    // la cuenta se bloquea antes de tocar nada: dos comensales de la misma mesa
    // pidiendo a la vez se serializan en vez de recalcular el total cada uno
    // sobre un conjunto de líneas que el otro ya cambió.
    const bill = await billItems.lockOpenBill(client, { restaurantId, billId });

    let order;
    if (heldOrderId) {
      order = await client.query(
        `UPDATE guest_orders
            SET status = 'PLACED', bill_id = $3, held_items = NULL,
                decided_at = NOW(), decided_by = $4,
                acknowledged_at = NOW(), acknowledged_by = $4
          WHERE id = $1 AND restaurant_id = $2 AND status = 'HELD'
        RETURNING id, created_at`,
        [heldOrderId, restaurantId, billId, decidedBy]
      );
      // Lo decidió otro mientras tanto: el bloqueo de la mesa lo serializa.
      if (!order.rows.length) await throwAlreadyDecided(client, { restaurantId, orderId: heldOrderId });
      if (guestSessionId) {
        await client.query(
          `UPDATE guest_sessions SET orders_approved_at = COALESCE(orders_approved_at, NOW())
            WHERE id = $1 AND restaurant_id = $2`,
          [guestSessionId, restaurantId]
        );
      }
    } else {
      order = await client.query(
        `INSERT INTO guest_orders (restaurant_id, table_id, guest_session_id, bill_id, line_count, note)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at`,
        [restaurantId, tableId, guestSessionId, billId, items.length, note || null]
      );
    }

    const { added, bill: updated } = await billItems.addItemsInTransaction(client, {
      restaurantId, bill, items, guestOrderId: order.rows[0].id
    });

    return {
      orderId: order.rows[0].id,
      createdAt: order.rows[0].created_at,
      status: STATUS.PLACED,
      opened,
      bill: updated,
      added
    };
  }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });
}

/**
 * ¿Tiene que esperar a la sala el pedido de esta sesión?
 *
 * Sólo si el restaurante lo tiene encendido y la sala todavía no le ha
 * aprobado ninguno. Una sesión sin fila (purgada) cuenta como nueva.
 */
async function approvalGate({ restaurantId, sessionId }, client = db) {
  const { rows } = await client.query(
    `SELECT r.approve_new_phone_orders AS required,
            s.orders_approved_at, s.orders_rejected_at
       FROM restaurants r
       LEFT JOIN guest_sessions s ON s.id = $2 AND s.restaurant_id = r.id
      WHERE r.id = $1`,
    [restaurantId, sessionId]
  );
  const row = rows[0];
  return {
    rejected: Boolean(row?.orders_rejected_at),
    needsApproval: Boolean(row?.required) && !row?.orders_approved_at
  };
}

/**
 * El primer pedido de un teléfono nuevo, apartado hasta que la sala lo mire.
 *
 * No toca ninguna cuenta y no abre ninguna: precisamente es lo que se quiere
 * evitar que haga alguien desde fuera con una foto del QR. Se valida ya lo que
 * se puede validar -- que los productos existen, son de este restaurante y
 * siguen en la carta -- y se guarda una foto de nombre y precio para que la
 * bandeja enseñe qué se pidió. Al aprobarlo se vuelve a validar todo contra la
 * cuenta, como cualquier pedido.
 */
async function holdOrder({ restaurantId, tableId, guestSessionId, items, note }) {
  return db.withTransaction(async client => {
    const table = await client.query(
      'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true',
      [tableId, restaurantId]
    );
    if (!table.rows.length) throw new ApiError('TABLE_NOT_FOUND', 'Table not found');

    // Una sesión cuya cuenta ya terminó no pide nada, retenido o no.
    const found = await guestBillBinding.billForSession(
      { restaurantId, tableId, sessionId: guestSessionId }, client);
    if (!found.billId && found.reason !== guestBillBinding.REASONS.NO_OPEN_BILL) {
      throw new ApiError('OPEN_BILL_NOT_FOUND', 'This session\'s bill has ended; scan the table again',
        { reason: found.reason });
    }

    const held = [];
    for (const line of items) {
      const { rows } = await client.query(
        `SELECT id, name, price_minor_units, currency, active
           FROM menu_products WHERE id = $1 AND restaurant_id = $2`,
        [line.productId, restaurantId]
      );
      const product = rows[0];
      if (!product) throw new ApiError('PRODUCT_NOT_FOUND', 'Product not found', { productId: line.productId });
      if (!product.active) {
        throw new ApiError('PRODUCT_INACTIVE', `${product.name} is no longer on the menu`, { productId: product.id });
      }
      const quantity = line.quantity ?? 1;
      held.push({
        productId: product.id,
        quantity,
        name: product.name,
        currency: product.currency,
        subtotalMinor: (BigInt(product.price_minor_units) * BigInt(quantity)).toString()
      });
    }

    let order;
    try {
      order = await client.query(
        `INSERT INTO guest_orders (restaurant_id, table_id, guest_session_id, bill_id, line_count, note,
                                   status, held_items)
         VALUES ($1, $2, $3, NULL, $4, $5, 'HELD', $6::jsonb)
         RETURNING id, created_at`,
        [restaurantId, tableId, guestSessionId, items.length, note || null, JSON.stringify(held)]
      );
    } catch (err) {
      if (err.code === '23505' && /one_held_per_session/.test(err.constraint || err.message)) {
        throw new ApiError('GUEST_ORDER_AWAITING_APPROVAL',
          'Your first order is waiting for the staff to approve it');
      }
      throw err;
    }
    return {
      orderId: order.rows[0].id,
      createdAt: order.rows[0].created_at,
      status: STATUS.HELD,
      opened: false
    };
  });
}

async function throwAlreadyDecided(client, { restaurantId, orderId }) {
  const { rows } = await client.query(
    'SELECT status FROM guest_orders WHERE id = $1 AND restaurant_id = $2', [orderId, restaurantId]);
  if (!rows.length) throw new ApiError('GUEST_ORDER_NOT_FOUND', 'Order not found');
  throw new ApiError('GUEST_ORDER_ALREADY_DECIDED', 'This order is not waiting for approval',
    { status: rows[0].status });
}

/**
 * La sala aprueba un pedido retenido: entra en la cuenta -- abriéndola si la
 * mesa está libre -- con las mismas validaciones que cualquier otro, y ese
 * teléfono ya pide sin esperar.
 */
async function approve({ restaurantId, orderId, userId }) {
  const { rows } = await db.query(
    `SELECT id, table_id, guest_session_id, note, status, held_items
       FROM guest_orders WHERE id = $1 AND restaurant_id = $2`,
    [orderId, restaurantId]
  );
  const held = rows[0];
  if (!held) throw new ApiError('GUEST_ORDER_NOT_FOUND', 'Order not found');
  if (held.status !== STATUS.HELD) {
    throw new ApiError('GUEST_ORDER_ALREADY_DECIDED', 'This order is not waiting for approval',
      { status: held.status });
  }
  return commitOrder({
    restaurantId,
    tableId: held.table_id,
    guestSessionId: held.guest_session_id,
    items: held.held_items.map(i => ({ productId: i.productId, quantity: i.quantity })),
    note: held.note,
    heldOrderId: held.id,
    decidedBy: userId
  });
}

/**
 * La sala rechaza un pedido retenido. No llega a ninguna cuenta, y ese teléfono
 * no puede volver a pedir: tendría que escanear otra vez.
 *
 * Idempotente como el «visto»: rechazar dos veces no es un error.
 */
async function reject({ restaurantId, orderId, userId }) {
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `UPDATE guest_orders
          SET status = 'REJECTED', decided_at = NOW(), decided_by = $3,
              acknowledged_at = NOW(), acknowledged_by = $3
        WHERE id = $1 AND restaurant_id = $2 AND status = 'HELD'
      RETURNING id, decided_at, guest_session_id`,
      [orderId, restaurantId, userId]
    );
    if (!rows.length) {
      const existing = await client.query(
        'SELECT id, status, decided_at FROM guest_orders WHERE id = $1 AND restaurant_id = $2',
        [orderId, restaurantId]);
      if (!existing.rows.length) throw new ApiError('GUEST_ORDER_NOT_FOUND', 'Order not found');
      if (existing.rows[0].status === STATUS.REJECTED) {
        return { id: orderId, status: STATUS.REJECTED, decidedAt: existing.rows[0].decided_at, changed: false };
      }
      throw new ApiError('GUEST_ORDER_ALREADY_DECIDED', 'This order is not waiting for approval',
        { status: existing.rows[0].status });
    }
    if (rows[0].guest_session_id) {
      await client.query(
        `UPDATE guest_sessions SET orders_rejected_at = COALESCE(orders_rejected_at, NOW())
          WHERE id = $1 AND restaurant_id = $2`,
        [rows[0].guest_session_id, restaurantId]
      );
    }
    return { id: rows[0].id, status: STATUS.REJECTED, decidedAt: rows[0].decided_at, changed: true };
  });
}

/** En qué quedó un pedido, para el teléfono que lo mandó y sólo para él. */
async function statusForSession({ restaurantId, sessionId, orderId }) {
  const { rows } = await db.query(
    `SELECT id, status, created_at, decided_at FROM guest_orders
      WHERE id = $1 AND restaurant_id = $2 AND guest_session_id = $3`,
    [orderId, restaurantId, sessionId]
  );
  if (!rows.length) throw new ApiError('GUEST_ORDER_NOT_FOUND', 'Order not found');
  return rows[0];
}

async function getSettings({ restaurantId }) {
  const { rows } = await db.query(
    'SELECT approve_new_phone_orders FROM restaurants WHERE id = $1', [restaurantId]);
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
  return { approveNewPhones: rows[0].approve_new_phone_orders };
}

async function updateSettings({ restaurantId, approveNewPhones }) {
  const { rows } = await db.query(
    `UPDATE restaurants SET approve_new_phone_orders = $2 WHERE id = $1
     RETURNING approve_new_phone_orders`,
    [restaurantId, approveNewPhones]
  );
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
  return { approveNewPhones: rows[0].approve_new_phone_orders };
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
    `SELECT o.id, o.table_id, o.bill_id, o.line_count, o.note, o.created_at,
            o.status, o.held_items,
            t.name AS table_name,
            -- Quién tiene atribuida la cuenta, que en un pedido por QR suele
            -- ser nadie: la abrió el comensal. Va aquí para que la bandeja
            -- pueda ofrecer "lo atiendo yo" sólo cuando de verdad falta.
            b.served_by AS served_by,
            -- La moneda de los importes de las líneas: la de la cuenta. Una carta
            -- en dólares deja las líneas en dólares, y la bandeja las daba por
            -- bolívares.
            b.currency AS currency,
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
      GROUP BY o.id, t.name, b.served_by, b.currency
      -- Los que esperan aprobación, primero: retienen a un comensal.
      ORDER BY (o.status = 'HELD') DESC, o.created_at ASC
      LIMIT $2`,
    [restaurantId, limit]
  );
  return rows;
}

/** Cuántos esperan. El panel lo pide cada pocos segundos; una lista entera no. */
async function pendingSummary({ restaurantId }) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS pending, min(created_at) AS oldest,
            count(*) FILTER (WHERE status = 'HELD')::int AS awaiting_approval
       FROM guest_orders
      WHERE restaurant_id = $1 AND acknowledged_at IS NULL`,
    [restaurantId]
  );
  const { pending, oldest, awaiting_approval: awaitingApproval } = rows[0];
  return {
    pending,
    awaitingApproval,
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
      WHERE id = $1 AND restaurant_id = $2 AND acknowledged_at IS NULL AND status <> 'HELD'
      RETURNING id, acknowledged_at`,
    [orderId, restaurantId, userId]
  );
  if (rows.length) return { id: rows[0].id, acknowledgedAt: rows[0].acknowledged_at, changed: true };

  const existing = await db.query(
    'SELECT id, acknowledged_at, status FROM guest_orders WHERE id = $1 AND restaurant_id = $2',
    [orderId, restaurantId]
  );
  if (!existing.rows.length) throw new ApiError('GUEST_ORDER_NOT_FOUND', 'Order not found');
  // Darlo por visto no lo aprueba: las líneas no están en la cuenta.
  if (existing.rows[0].status === STATUS.HELD) {
    throw new ApiError('GUEST_ORDER_NEEDS_APPROVAL', 'Approve or reject this order; it is not on the bill yet');
  }
  return {
    id: existing.rows[0].id,
    acknowledgedAt: existing.rows[0].acknowledged_at,
    changed: false
  };
}

module.exports = {
  STATUS, placeOrder, approvalGate, approve, reject, statusForSession,
  getSettings, updateSettings, listPending, pendingSummary, acknowledge
};
