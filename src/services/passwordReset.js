const crypto = require('crypto');

const config = require('../config');
const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');
const { hashToken } = require('../utils/tokens');
const { hashPassword, revokeAllSessionsForUser } = require('./auth');
const { logAudit } = require('./audit');
const mailer = require('./mailer');

/**
 * «¿Olvidaste tu contraseña?»
 *
 * Antes no había forma de volver a entrar sin que otro dueño o encargado te
 * pusiera una contraseña nueva, y un dueño solo no tenía ninguna.
 *
 * Lo que decide la seguridad, como en las invitaciones (`staffInvitations.js`):
 *
 *   - El token son 32 bytes al azar y **sólo se guarda su hash**.
 *   - Va en el **fragmento** del enlace (`#...`): el navegador no lo manda al
 *     servidor, así que no acaba en registros de acceso ni en el Referer.
 *   - Caduca en 30 minutos, sirve una vez, y pedir otro anula el anterior.
 *   - **Pedirlo no revela si la dirección tiene cuenta**: la respuesta es la
 *     misma, y el correo sale fuera de la petición, así que tampoco el tiempo
 *     de respuesta lo delata.
 *   - Como mucho tres por cuenta y hora, además del límite por IP de /auth: que
 *     nadie llene el buzón de otro.
 *   - Usarlo cierra **todas** las sesiones de esa cuenta. Quien pide esto suele
 *     sospechar que su contraseña la sabe alguien más.
 *   - No se salta el segundo factor: quien lo tenga activo lo sigue necesitando
 *     para entrar.
 */

const TTL_MINUTES = 30;
const MAX_PER_HOUR = 3;

function linkFor(token) {
  return `${config.onboarding.appBaseUrl}/restablecer#${token}`;
}

/** Mismo criterio que las invitaciones: con el transporte `log` en producción, el enlace acabaría en los registros. */
function canEmail() {
  return !(process.env.NODE_ENV === 'production' && config.mail.transport === 'log');
}

async function sendResetEmail({ email, link }) {
  if (!canEmail()) {
    logger.warn({ event: 'PASSWORD_RESET_NOT_EMAILED' }, 'Password reset requested but mail transport cannot carry links');
    return false;
  }
  const result = await mailer.send({
    to: email,
    fromName: 'Splite',
    subject: 'Restablece tu contraseña de Splite',
    text: [
      'Hola:',
      '',
      'Alguien pidió restablecer la contraseña de tu cuenta de Splite. Si fuiste tú, abre este enlace y elige una nueva:',
      link,
      '',
      `El enlace sirve una sola vez y caduca en ${TTL_MINUTES} minutos. Al usarlo se cierran todas las sesiones abiertas de tu cuenta.`,
      '',
      'Si no lo pediste, ignora este correo: tu contraseña no cambia.',
      '',
      'Este correo lo envía Splite y no recibe respuestas.'
    ].join('\n')
  });
  return Boolean(result?.sent);
}

/**
 * Pedir un enlace. Siempre «vale»: quien llama no sabe si la dirección existe.
 *
 * Devuelve `{ token }` sólo cuando se creó uno, para las pruebas; la ruta no lo
 * devuelve nunca.
 */
async function requestReset({ email, meta = {} }) {
  const { rows } = await db.query(
    `SELECT id, restaurant_id, email FROM users
      WHERE lower(email) = lower($1) AND active = true`,
    [email]
  );
  const user = rows[0];
  if (!user) return {};

  const recent = await db.query(
    `SELECT count(*)::int AS n FROM password_resets
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '1 hour'`,
    [user.id]
  );
  if (recent.rows[0].n >= MAX_PER_HOUR) {
    await logAudit({
      ...meta,
      restaurantId: user.restaurant_id,
      actorId: user.id,
      action: 'AUTH_PASSWORD_RESET_THROTTLED'
    });
    return {};
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await db.withTransaction(async client => {
    await client.query(
      `UPDATE password_resets SET revoked_at = NOW()
        WHERE user_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [user.id]
    );
    await client.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, NOW() + make_interval(mins => $3))`,
      [user.id, hashToken(token), TTL_MINUTES]
    );
  });

  await logAudit({
    ...meta,
    restaurantId: user.restaurant_id,
    actorId: user.id,
    action: 'AUTH_PASSWORD_RESET_REQUESTED'
  });

  // Fuera de la petición: esperar al proveedor de correo haría que una
  // dirección con cuenta tardara más en responder que una sin ella.
  sendResetEmail({ email: user.email, link: linkFor(token) }).catch(err =>
    logger.error({ event: 'PASSWORD_RESET_MAIL_FAILED', err: err.message }, 'Password reset email failed'));

  return { token };
}

/**
 * Usar el enlace: contraseña nueva y todas las sesiones fuera.
 *
 * Bajo bloqueo de la fila, para que dos envíos del mismo enlace no hagan dos
 * cambios. No inicia sesión: quien acaba de elegir contraseña entra con ella,
 * y con su segundo factor si lo tiene.
 */
async function completeReset({ token, password, meta = {} }) {
  const passwordHash = await hashPassword(password);
  const user = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT r.id, r.user_id, u.restaurant_id, u.active
         FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1
          AND r.used_at IS NULL AND r.revoked_at IS NULL AND r.expires_at > NOW()
        FOR UPDATE OF r`,
      [hashToken(token)]
    );
    const reset = rows[0];
    // Uno solo para todos los casos -- caducado, usado, anulado, inventado --:
    // distinguirlos sólo le sirve a quien está probando tokens.
    if (!reset || !reset.active) {
      throw new ApiError('PASSWORD_RESET_INVALID', 'This reset link is invalid or has expired; ask for a new one');
    }
    await client.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [reset.id]);
    // Cualquier otro enlace vivo de la misma cuenta deja de valer.
    await client.query(
      `UPDATE password_resets SET revoked_at = NOW()
        WHERE user_id = $1 AND id <> $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [reset.user_id, reset.id]
    );
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [reset.user_id, passwordHash]);
    return { id: reset.user_id, restaurantId: reset.restaurant_id };
  });

  const revoked = await revokeAllSessionsForUser(user.id);
  await logAudit({
    ...meta,
    restaurantId: user.restaurantId,
    actorId: user.id,
    action: 'AUTH_PASSWORD_RESET_COMPLETED',
    details: { sessionsRevoked: revoked }
  });
  return { sessionsRevoked: revoked };
}

module.exports = { requestReset, completeReset, TTL_MINUTES, MAX_PER_HOUR };
