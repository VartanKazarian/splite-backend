const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const inFlight = require('./inFlight');

/**
 * Reservas de pago: el comensal que pulsa «Pagar» aparta lo que va a
 * transferir, y los demás de la mesa no pueden empezar a pagar eso mismo.
 *
 * Por qué hace falta: un Pago Móvil va del banco del comensal al del
 * restaurante sin pasar por Splite. Cuando la cuenta se cierra, la segunda
 * transferencia ya se hizo. El único momento en que Splite puede evitarla es
 * antes, cuando el segundo comensal todavía no ha ido a su banco.
 *
 * Lo que una reserva NO hace: impedir un aviso. Quien ya transfirió avisa
 * igual (paymentClaims.declareClaim no mira reservas), porque rechazarle
 * dejaría dinero real sin registro. La reserva es para el que aún no pagó.
 *
 * Activa = sin soltar, sin usar y sin caducar. Caducar no necesita un proceso:
 * todas las lecturas filtran por expires_at.
 */

const LIVE = 'released_at IS NULL AND consumed_by_payment_id IS NULL AND expires_at > NOW()';

/**
 * Reservas vivas de una cuenta, separadas en las del propio comensal y las
 * de los demás. Pasa `client` dentro de una transacción para leer bajo su
 * bloqueo.
 */
async function liveForBill({ restaurantId, billId, viewerSessionId = null }, client = db) {
  const { rows } = await client.query(
    `SELECT id, guest_session_id, split_participant_id, amount_ves, expires_at
       FROM payment_holds
      WHERE restaurant_id = $1 AND bill_id = $2 AND ${LIVE}
      ORDER BY expires_at ASC`,
    [restaurantId, billId]
  );

  let othersVes = 0n;
  let othersUntil = null;
  const othersByShare = new Map();
  let mine = null;
  for (const row of rows) {
    if (viewerSessionId && row.guest_session_id === viewerSessionId) {
      mine = row;
      continue;
    }
    const amount = BigInt(row.amount_ves);
    othersVes += amount;
    if (!othersUntil) othersUntil = row.expires_at;
    if (row.split_participant_id) {
      othersByShare.set(row.split_participant_id,
        (othersByShare.get(row.split_participant_id) ?? 0n) + amount);
    }
  }
  return { othersVes, othersUntil, othersByShare, mine, count: rows.length };
}

function heldError(message, { availableVes, heldVes, pendingVes, heldUntil }) {
  return new ApiError('PAYMENT_HELD', message, {
    availableVes: availableVes.toString(),
    heldVes: heldVes.toString(),
    pendingVes: pendingVes.toString(),
    heldUntil: heldUntil ? new Date(heldUntil).toISOString() : null
  });
}

/**
 * Reserva `amountVes` de la cuenta (o de una parte del reparto) para este
 * comensal durante config.guest.paymentHoldSeconds.
 *
 * Bajo el mismo bloqueo de fila que avisos, pagos y anulaciones, así que dos
 * comensales que pulsan «Pagar» a la vez se ordenan: el segundo ve la reserva
 * del primero y recibe PAYMENT_HELD con lo que queda libre.
 *
 * Volver a reservar cambia la reserva propia en vez de apilar otra.
 */
async function placeHold({ restaurantId, billId, sessionId, amountVes, splitParticipantId = null }) {
  const amount = BigInt(amountVes);
  if (amount <= 0n) {
    throw new ApiError('VALIDATION_FAILED', 'amountVes must be positive', { fields: ['amountVes'] });
  }

  return db.withTransaction(async client => {
    const bill = (await client.query(
      `SELECT id, status, total_due_ves, amount_paid_ves FROM bills
        WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [billId, restaurantId]
    )).rows[0];
    if (!bill) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
    if (bill.status !== 'OPEN') {
      throw new ApiError('BILL_NOT_OPEN', `A ${bill.status} bill cannot take payments`, { status: bill.status });
    }

    const pending = await inFlight.forBill({ restaurantId, billId }, client);
    const holds = await liveForBill({ restaurantId, billId, viewerSessionId: sessionId }, client);

    const remaining = BigInt(bill.total_due_ves) - BigInt(bill.amount_paid_ves);
    // Más de lo que se debe no es «otro está pagando»: es otro error, el mismo
    // que daría el aviso.
    if (amount > remaining) {
      throw new ApiError('PAYMENT_EXCEEDS_BALANCE', 'Payment exceeds remaining bill balance', {
        remainingVes: remaining.toString()
      });
    }
    const available = inFlight.available(remaining, pending.totalVes + holds.othersVes);
    if (amount > available) {
      throw heldError('Someone at the table is already paying part of this balance', {
        availableVes: available, heldVes: holds.othersVes, pendingVes: pending.totalVes,
        heldUntil: holds.othersUntil
      });
    }

    if (splitParticipantId) {
      const share = (await client.query(
        `SELECT p.id, p.amount_ves, p.amount_paid_ves
           FROM bill_split_participants p
           JOIN bill_splits s ON s.id = p.split_id AND s.restaurant_id = p.restaurant_id
          WHERE p.id = $1 AND p.restaurant_id = $2 AND s.bill_id = $3 AND s.status <> 'VOID'
          FOR UPDATE OF p`,
        [splitParticipantId, restaurantId, billId]
      )).rows[0];
      if (!share) throw new ApiError('SPLIT_NOT_FOUND', 'That share is not part of this bill');

      const shareRemaining = BigInt(share.amount_ves) - BigInt(share.amount_paid_ves);
      const sharePending = pending.byShare.get(share.id) ?? 0n;
      const shareHeld = holds.othersByShare.get(share.id) ?? 0n;
      const shareAvailable = inFlight.available(shareRemaining, sharePending + shareHeld);
      if (amount > shareAvailable) {
        throw heldError('Someone is already paying this share', {
          availableVes: shareAvailable, heldVes: shareHeld, pendingVes: sharePending,
          heldUntil: holds.othersUntil
        });
      }
    }

    const ttl = config.guest.paymentHoldSeconds;
    // Lo propio se cambia, sea viva o caducada: el índice único cuenta como
    // «abierta» cualquier reserva sin soltar ni usar.
    const updated = (await client.query(
      `UPDATE payment_holds
          SET amount_ves = $4, split_participant_id = $5,
              expires_at = NOW() + make_interval(secs => $6), created_at = NOW()
        WHERE restaurant_id = $1 AND bill_id = $2 AND guest_session_id = $3
          AND released_at IS NULL AND consumed_by_payment_id IS NULL
      RETURNING *`,
      [restaurantId, billId, sessionId, amount.toString(), splitParticipantId, ttl]
    )).rows[0];
    if (updated) return updated;

    return (await client.query(
      `INSERT INTO payment_holds
         (restaurant_id, bill_id, guest_session_id, split_participant_id, amount_ves, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(secs => $6))
       RETURNING *`,
      [restaurantId, billId, sessionId, splitParticipantId, amount.toString(), ttl]
    )).rows[0];
  });
}

/** Suelta la reserva propia, si la hay. Idempotente. */
async function releaseHold({ restaurantId, billId, sessionId }) {
  const { rowCount } = await db.query(
    `UPDATE payment_holds SET released_at = NOW()
      WHERE restaurant_id = $1 AND bill_id = $2 AND guest_session_id = $3
        AND released_at IS NULL AND consumed_by_payment_id IS NULL`,
    [restaurantId, billId, sessionId]
  );
  return rowCount > 0;
}

/**
 * Al avisar, la reserva de ese comensal pasa a ser el aviso: desde ahí lo
 * apartado cuenta como pago en verificación, no dos veces. Corre en la
 * transacción del aviso.
 */
async function consumeForSession(client, { restaurantId, billId, sessionId, paymentId }) {
  if (!sessionId) return;
  await client.query(
    `UPDATE payment_holds SET consumed_by_payment_id = $4
      WHERE restaurant_id = $1 AND bill_id = $2 AND guest_session_id = $3
        AND released_at IS NULL AND consumed_by_payment_id IS NULL`,
    [restaurantId, billId, sessionId, paymentId]
  );
}

module.exports = { placeHold, releaseHold, consumeForSession, liveForBill };
