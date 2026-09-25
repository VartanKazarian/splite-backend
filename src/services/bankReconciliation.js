const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const { matchClaim } = require('../payments/validation/match');

/**
 * Los movimientos del banco contra los avisos de Pago Móvil pendientes.
 *
 * Es la pieza común a cualquier banco: una fuente (un webhook, un estado de
 * cuenta subido, la API de un banco el día que la haya) sólo tiene que traer
 * movimientos normalizados, y lo que decide si un aviso está pagado es esto y
 * nada más. La regla de fondo es la de `payments/validation/match.js`: no ser
 * más laxo que el mesero. Sólo `MATCHED` confirma, y sólo si la conexión de ese
 * movimiento lo permite; todo lo demás queda anotado para que lo mire una
 * persona.
 *
 * Lo que no se ve en el matcher y se decide aquí:
 *
 *   - **El importe es lo que llegó al banco**: parte + propina, en una sola
 *     transferencia. Comparar sólo la parte no casaría nunca con un aviso con
 *     propina.
 *   - **Un movimiento respalda un aviso como mucho.** Si dos avisos casan con el
 *     mismo movimiento -- dos personas declarando la misma referencia, que es
 *     justo lo que haría quien copia la de otro --, los dos pasan a AMBIGUOUS y
 *     no se confirma ninguno.
 *   - **Sólo movimientos recientes y sin usar.** Una referencia de hace un mes
 *     no respalda un aviso de hoy.
 */

/** Hasta dónde se mira atrás. Un aviso no espera más que esto a su dinero. */
const WINDOW_DAYS = 7;

/** El aviso con la forma que espera el matcher. */
function claimShape(row) {
  const metadata = row.metadata || {};
  return {
    reference: row.declared_reference ?? '',
    amountMinor: (BigInt(row.amount_ves) + BigInt(row.tip_ves ?? 0)).toString(),
    bankCode: metadata.bankOrigin ?? null,
    phoneOrigin: metadata.phoneOrigin ?? null,
    idOrigin: metadata.idOrigin ?? null
  };
}

function movementShape(row) {
  return {
    id: row.id,
    reference: row.reference,
    amountMinor: String(row.amount_minor),
    bankCode: row.bank_code ?? null,
    phoneOrigin: row.phone_origin ?? null,
    idOrigin: row.id_origin ?? null,
    autoConfirm: row.auto_confirm === true
  };
}

/**
 * Decide, sin tocar la base, qué dice el banco de cada aviso.
 *
 * Pura para que la regla de «un movimiento, un aviso» se pruebe sin base de
 * datos: devuelve por aviso el desenlace ya corregido.
 */
function decide(claims, movements) {
  const results = claims.map(c => ({ claimId: c.id, ...matchClaim(claimShape(c), movements) }));

  const claimsPerMovement = new Map();
  for (const r of results) {
    if (r.outcome === 'MATCHED') {
      claimsPerMovement.set(r.movement.id, (claimsPerMovement.get(r.movement.id) ?? 0) + 1);
    }
  }
  return results.map(r => (
    r.outcome === 'MATCHED' && claimsPerMovement.get(r.movement.id) > 1
      ? { ...r, outcome: 'AMBIGUOUS', movement: null, disagreements: [] }
      : r
  ));
}

/**
 * Mira los avisos pendientes del restaurante contra sus movimientos.
 *
 * Devuelve cuántos hay de cada. Nunca lanza por un aviso concreto: si uno no
 * se puede confirmar -- lo resolvió alguien a la vez, la cuenta ya está
 * pagada --, se anota y se sigue con el resto.
 */
async function reconcile({ restaurantId }) {
  const [{ rows: claims }, { rows: movementRows }] = await Promise.all([
    db.query(
      `SELECT id, amount_ves, tip_ves, declared_reference, metadata
         FROM payments
        WHERE restaurant_id = $1 AND payment_method = 'PAGO_MOVIL' AND status = 'PENDING'`,
      [restaurantId]
    ),
    db.query(
      `SELECT m.id, m.reference, m.amount_minor, m.bank_code, m.phone_origin, m.id_origin,
              c.auto_confirm
         FROM bank_movements m
         JOIN bank_connections c ON c.id = m.connection_id AND c.restaurant_id = m.restaurant_id
        WHERE m.restaurant_id = $1 AND m.matched_payment_id IS NULL AND c.active
          AND m.received_at > now() - ($2 * INTERVAL '1 day')`,
      [restaurantId, WINDOW_DAYS]
    )
  ]);

  const counts = { matched: 0, mismatch: 0, ambiguous: 0, notFound: 0, autoConfirmed: 0 };
  const key = { MATCHED: 'matched', MISMATCH: 'mismatch', AMBIGUOUS: 'ambiguous', NOT_FOUND: 'notFound' };
  if (!claims.length) return counts;

  const movements = movementRows.map(movementShape);
  const decisions = decide(claims, movements);

  for (const d of decisions) {
    counts[key[d.outcome]] += 1;
    await db.query(
      `INSERT INTO payment_bank_matches (payment_id, restaurant_id, outcome, movement_id, disagreements, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (payment_id) DO UPDATE
         SET outcome = EXCLUDED.outcome, movement_id = EXCLUDED.movement_id,
             disagreements = EXCLUDED.disagreements, checked_at = now()`,
      [d.claimId, restaurantId, d.outcome, d.movement?.id ?? null, d.disagreements ?? []]
    );
  }

  // Confirmar sólo lo que casó sin dudas y viene de una conexión en la que el
  // restaurante confía. Requerido tarde para no crear un ciclo de módulos.
  const claimsService = require('./paymentClaims');
  for (const d of decisions) {
    if (d.outcome !== 'MATCHED' || !d.movement.autoConfirm) continue;
    try {
      await claimsService.confirmClaim({
        restaurantId, claimId: d.claimId, actor: null, via: 'BANK', bankMovementId: d.movement.id
      });
      await db.query(
        'UPDATE payment_bank_matches SET auto_confirmed = true WHERE payment_id = $1',
        [d.claimId]
      );
      counts.autoConfirmed += 1;
    } catch (err) {
      logger.warn(
        { event: 'BANK_AUTO_CONFIRM_SKIPPED', restaurantId, claimId: d.claimId, code: err.code },
        'A bank-matched claim could not be confirmed automatically'
      );
    }
  }

  return counts;
}

/**
 * Tras declarar un aviso: si el restaurante tiene alguna conexión, se mira ya,
 * por si el dinero llegó antes que el aviso. Nunca lanza: un fallo aquí no
 * puede convertir un aviso bien declarado en un error delante del comensal.
 */
async function reconcileAfterClaim(restaurantId) {
  try {
    const { rows } = await db.query(
      'SELECT 1 FROM bank_connections WHERE restaurant_id = $1 AND active LIMIT 1',
      [restaurantId]
    );
    if (rows.length) await reconcile({ restaurantId });
  } catch (err) {
    logger.warn({ event: 'BANK_RECONCILE_FAILED', restaurantId, err }, 'Reconciliation after a claim failed');
  }
}

/** Lo que el banco dice de un aviso, para la pantalla del personal. */
function bankMatchView(row) {
  if (!row.bank_match_outcome) return null;
  return {
    outcome: row.bank_match_outcome,
    disagreements: row.bank_match_disagreements ?? [],
    movementReference: row.bank_match_reference ?? null,
    autoConfirmed: row.bank_match_auto === true,
    checkedAt: row.bank_match_checked_at ? new Date(row.bank_match_checked_at).toISOString() : null
  };
}

module.exports = { WINDOW_DAYS, reconcile, reconcileAfterClaim, decide, claimShape, bankMatchView };
