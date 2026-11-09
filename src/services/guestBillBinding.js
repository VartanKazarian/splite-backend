const db = require('../connectors/base');
const config = require('../config');

/**
 * La cuenta de una sesión de comensal.
 *
 * Una sesión vale para una cuenta, no para la mesa. Sin esto, quien se iba con
 * la sesión abierta veía -- y podía pedir sobre -- la cuenta de los siguientes
 * en sentarse, durante las dos horas de inactividad que dura una sesión.
 *
 * Reglas:
 * 1. Atada: es esa cuenta y ninguna otra. Si ya no está abierta, la sesión no
 *    tiene cuenta (`SESSION_BILL_ENDED`), aunque en la mesa haya otra abierta.
 * 2. Sin atar y con cuenta abierta en la mesa: se ata a ella, salvo que esa
 *    cuenta se abriera más de config.guest.billBindWindowSeconds después de la
 *    sesión (`SESSION_PREDATES_BILL`): quien escaneó una mesa vacía hace una
 *    hora ya no es, probablemente, quien está sentado ahora.
 * 3. Sin atar y sin cuenta: no hay cuenta (el pedido del comensal puede abrir
 *    una, y entonces se ata a ella: `bindSession`).
 *
 * Volver a escanear crea una sesión nueva, que se ata a la cuenta de ahora.
 *
 * El atado es condicional (`bill_id IS NULL`): dos peticiones de la misma
 * sesión a la vez no la atan a dos cuentas distintas.
 */

const REASONS = Object.freeze({
  SESSION_BILL_ENDED: 'SESSION_BILL_ENDED',
  SESSION_PREDATES_BILL: 'SESSION_PREDATES_BILL',
  NO_OPEN_BILL: 'NO_OPEN_BILL'
});

/**
 * @returns {Promise<{ billId: string|null, reason: string|null }>}
 */
async function billForSession({ restaurantId, tableId, sessionId }, client = db) {
  const session = (await client.query(
    `SELECT bill_id, created_at FROM guest_sessions
      WHERE id = $1 AND restaurant_id = $2 AND table_id = $3`,
    [sessionId, restaurantId, tableId]
  )).rows[0];
  // Sin fila (no debería pasar con una sesión ya autenticada): sin cuenta.
  if (!session) return { billId: null, reason: REASONS.NO_OPEN_BILL };

  if (session.bill_id) {
    const bound = (await client.query(
      'SELECT status FROM bills WHERE id = $1 AND restaurant_id = $2',
      [session.bill_id, restaurantId]
    )).rows[0];
    if (bound?.status === 'OPEN') return { billId: session.bill_id, reason: null };
    return { billId: null, reason: REASONS.SESSION_BILL_ENDED };
  }

  const open = (await client.query(
    `SELECT id,
            created_at > $3::timestamptz + make_interval(secs => $4) AS too_late
       FROM bills
      WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'`,
    [restaurantId, tableId, session.created_at, config.guest.billBindWindowSeconds]
  )).rows[0];
  if (!open) return { billId: null, reason: REASONS.NO_OPEN_BILL };
  if (open.too_late) return { billId: null, reason: REASONS.SESSION_PREDATES_BILL };

  const billId = await bindSession({ restaurantId, sessionId, billId: open.id }, client);
  return billId === open.id
    ? { billId, reason: null }
    // Otra petición de esta misma sesión la ató a otra cuenta entre medias.
    : billForSession({ restaurantId, tableId, sessionId }, client);
}

/**
 * Ata la sesión a la cuenta, si todavía no lo está. Devuelve la cuenta a la
 * que quedó atada (la suya de antes si ya tenía una).
 */
async function bindSession({ restaurantId, sessionId, billId }, client = db) {
  const updated = await client.query(
    `UPDATE guest_sessions SET bill_id = $3
      WHERE id = $1 AND restaurant_id = $2 AND bill_id IS NULL
    RETURNING bill_id`,
    [sessionId, restaurantId, billId]
  );
  if (updated.rows.length) return updated.rows[0].bill_id;
  const current = await client.query(
    'SELECT bill_id FROM guest_sessions WHERE id = $1 AND restaurant_id = $2',
    [sessionId, restaurantId]
  );
  return current.rows[0]?.bill_id ?? null;
}

module.exports = { billForSession, bindSession, REASONS };
