const crypto = require('crypto');

const config = require('../config');
const db = require('../connectors/base');
const { ApiError } = require('../errors');
const { safeEqual } = require('../utils/tokens');
const { logAudit } = require('./audit');
const { normalise } = require('./bankMovementNormalizer');
const reconciliation = require('./bankReconciliation');

/**
 * Las conexiones de un restaurante con su banco, y la entrada de movimientos.
 *
 * Una conexión no guarda ningún secreto. La firma de un webhook se **deriva**
 * del secreto del servidor (`WEBHOOK_SECRET`), del id de la conexión y de su
 * versión: se puede recalcular para verificar, no se puede leer de la base, y
 * rotarla es subir la versión. El prefijo `bank-inbound:` separa este uso del
 * de los webhooks de proveedores, que firman con el mismo secreto.
 */

/** Cuánto puede adelantarse o atrasarse una firma. Fuera de eso, se trata como una repetición. */
const SIGNATURE_WINDOW_SECONDS = 300;

/** Movimientos por petición. Un estado de cuenta grande se manda en tandas. */
const MAX_MOVEMENTS_PER_CALL = 500;

const CONNECTION_COLUMNS = `id, restaurant_id, kind, label, bank_code, auto_confirm, secret_version,
                            column_map, active, last_movement_at, last_error, last_error_at,
                            created_at, updated_at`;

function secretFor(connection) {
  return crypto
    .createHmac('sha256', config.webhookSecret)
    .update(`bank-inbound:v${connection.secret_version}:${connection.id}`)
    .digest('base64url');
}

/** La firma que se espera para un cuerpo y una hora. Exportada para las pruebas y la documentación. */
function signatureFor(secret, timestamp, rawBody) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;
}

function inboundPath(connectionId) {
  return `/api/v1/bank-inbound/${connectionId}`;
}

async function listConnections({ restaurantId }) {
  const { rows } = await db.query(
    `SELECT ${CONNECTION_COLUMNS} FROM bank_connections
      WHERE restaurant_id = $1 AND active ORDER BY created_at`,
    [restaurantId]
  );
  return rows;
}

async function getConnection({ restaurantId, connectionId }) {
  const { rows } = await db.query(
    `SELECT ${CONNECTION_COLUMNS} FROM bank_connections WHERE id = $1 AND restaurant_id = $2 AND active`,
    [connectionId, restaurantId]
  );
  if (!rows.length) throw new ApiError('BANK_CONNECTION_NOT_FOUND', 'Bank connection not found');
  return rows[0];
}

/**
 * Crear una conexión. La de tipo WEBHOOK devuelve su secreto **una vez**; para
 * verlo de nuevo, se rota.
 */
async function createConnection({ restaurantId, actor, kind, label, bankCode = null, meta = {} }) {
  const { rows } = await db.query(
    `INSERT INTO bank_connections (restaurant_id, kind, label, bank_code, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${CONNECTION_COLUMNS}`,
    [restaurantId, kind, label, bankCode, actor.id]
  );
  const connection = rows[0];
  await logAudit({
    ...meta, restaurantId, actorId: actor.id,
    action: 'BANK_CONNECTION_CREATED', resourceType: 'bank_connection', resourceId: connection.id,
    details: { kind, label }
  });
  return {
    connection,
    ...(kind === 'WEBHOOK' ? { secret: secretFor(connection), path: inboundPath(connection.id) } : {})
  };
}

/**
 * Cambiar nombre, confianza o mapeo de columnas, o dar de baja.
 *
 * `autoConfirm` se audita aparte: es la decisión de dejar que un movimiento
 * confirme un cobro sin que lo mire nadie.
 */
async function updateConnection({ restaurantId, actor, connectionId, changes, meta = {} }) {
  const current = await getConnection({ restaurantId, connectionId });
  const next = {
    label: changes.label ?? current.label,
    auto_confirm: changes.autoConfirm ?? current.auto_confirm,
    column_map: changes.columnMap === undefined ? current.column_map : changes.columnMap,
    active: changes.active ?? current.active
  };
  const { rows } = await db.query(
    `UPDATE bank_connections
        SET label = $3, auto_confirm = $4, column_map = $5, active = $6, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2
      RETURNING ${CONNECTION_COLUMNS}`,
    [connectionId, restaurantId, next.label, next.auto_confirm, next.column_map, next.active]
  );
  await logAudit({
    ...meta, restaurantId, actorId: actor.id,
    action: current.auto_confirm !== next.auto_confirm
      ? 'BANK_CONNECTION_AUTO_CONFIRM_CHANGED'
      : (next.active ? 'BANK_CONNECTION_UPDATED' : 'BANK_CONNECTION_REMOVED'),
    resourceType: 'bank_connection', resourceId: connectionId,
    details: { autoConfirm: next.auto_confirm, active: next.active }
  });
  // Encender la confianza puede confirmar lo que ya estaba casado.
  if (!current.auto_confirm && next.auto_confirm) await reconciliation.reconcile({ restaurantId });
  return rows[0];
}

async function rotateSecret({ restaurantId, actor, connectionId, meta = {} }) {
  const current = await getConnection({ restaurantId, connectionId });
  if (current.kind !== 'WEBHOOK') {
    throw new ApiError('BANK_CONNECTION_KIND_MISMATCH', 'Only a webhook connection has a signing secret');
  }
  const { rows } = await db.query(
    `UPDATE bank_connections SET secret_version = secret_version + 1, updated_at = now()
      WHERE id = $1 AND restaurant_id = $2 RETURNING ${CONNECTION_COLUMNS}`,
    [connectionId, restaurantId]
  );
  await logAudit({
    ...meta, restaurantId, actorId: actor.id,
    action: 'BANK_CONNECTION_SECRET_ROTATED', resourceType: 'bank_connection', resourceId: connectionId,
    details: { version: rows[0].secret_version }
  });
  return { connection: rows[0], secret: secretFor(rows[0]), path: inboundPath(connectionId) };
}

/**
 * Guardar movimientos y mirar los avisos pendientes.
 *
 * Idempotente: el mismo movimiento dos veces entra una (índice único por
 * restaurante, referencia e importe). Las filas que no se entienden vuelven con
 * su posición y su motivo, y no impiden que entren las demás.
 */
async function ingest({ connection, rows }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'No movements to import', { fieldPaths: ['movements'] });
  }
  if (rows.length > MAX_MOVEMENTS_PER_CALL) {
    throw new ApiError('VALIDATION_FAILED', `At most ${MAX_MOVEMENTS_PER_CALL} movements per call`, {
      fieldPaths: ['movements']
    });
  }

  const rejected = [];
  let inserted = 0;
  let duplicates = 0;
  for (const [index, row] of rows.entries()) {
    const n = normalise(row);
    if (!n.ok) {
      rejected.push({ index, reason: n.reason });
      continue;
    }
    const m = n.movement;
    const { rowCount } = await db.query(
      `INSERT INTO bank_movements
         (restaurant_id, connection_id, reference, amount_minor, occurred_at,
          phone_origin, id_origin, bank_code, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (restaurant_id, reference, amount_minor) DO NOTHING`,
      [connection.restaurant_id, connection.id, m.reference, m.amountMinor, m.occurredAt,
        m.phoneOrigin, m.idOrigin, m.bankCode, m.description]
    );
    if (rowCount) inserted += 1; else duplicates += 1;
  }

  await db.query(
    `UPDATE bank_connections
        SET last_movement_at = CASE WHEN $2::int > 0 THEN now() ELSE last_movement_at END,
            last_error = $3::varchar,
            last_error_at = CASE WHEN $3::varchar IS NULL THEN last_error_at ELSE now() END
      WHERE id = $1`,
    [connection.id, inserted,
      rejected.length ? `${rejected.length} de ${rows.length} movimientos no se entendieron` : null]
  );

  const matches = await reconciliation.reconcile({ restaurantId: connection.restaurant_id });
  return { received: rows.length, inserted, duplicates, rejected, matches };
}

/**
 * La entrada firmada: busca la conexión y comprueba firma y hora.
 *
 * Conexión inexistente, de baja, de otro tipo o firma mala responden igual,
 * para no decirle a quien prueba ids cuáles existen.
 */
async function authenticateInbound({ connectionId, timestamp, signature, rawBody, now = Date.now() }) {
  const denied = () => new ApiError('BANK_INBOUND_UNAUTHORIZED', 'Invalid signature');
  if (!/^[0-9a-f-]{36}$/i.test(String(connectionId))) throw denied();
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > SIGNATURE_WINDOW_SECONDS) throw denied();

  const { rows } = await db.query(
    `SELECT ${CONNECTION_COLUMNS} FROM bank_connections WHERE id = $1 AND active AND kind = 'WEBHOOK'`,
    [connectionId]
  );
  const connection = rows[0];
  if (!connection) throw denied();
  const expected = signatureFor(secretFor(connection), ts, rawBody);
  if (!safeEqual(String(signature ?? ''), expected)) throw denied();
  return connection;
}

/** Los últimos movimientos de una conexión, para ver que llegan. */
async function recentMovements({ restaurantId, connectionId, limit = 50 }) {
  await getConnection({ restaurantId, connectionId });
  const { rows } = await db.query(
    `SELECT id, reference, amount_minor, occurred_at, phone_origin, bank_code, description,
            received_at, matched_payment_id
       FROM bank_movements
      WHERE restaurant_id = $1 AND connection_id = $2
      ORDER BY received_at DESC LIMIT $3`,
    [restaurantId, connectionId, limit]
  );
  return rows;
}

module.exports = {
  SIGNATURE_WINDOW_SECONDS, MAX_MOVEMENTS_PER_CALL,
  listConnections, getConnection, createConnection, updateConnection, rotateSecret,
  ingest, authenticateInbound, recentMovements, signatureFor, secretFor, inboundPath
};
