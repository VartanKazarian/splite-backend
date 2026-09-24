const crypto = require('crypto');

const config = require('../config');
const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');
const { hashToken } = require('../utils/tokens');
const { hashPassword, issueSession } = require('./auth');
const { logAudit } = require('./audit');
const mailer = require('./mailer');

/**
 * Invitar a alguien del equipo.
 *
 * El alta con contraseña provisional sigue existiendo, pero tiene un defecto
 * que no se arregla con texto: la contraseña la inventa el dueño y la conocen
 * dos personas. Con una invitación, quien entra pone la suya y nadie más la ve.
 *
 * Lo que decide la seguridad de todo esto:
 *
 *   - El token son 32 bytes al azar y **sólo se guarda su hash**. El enlace se
 *     devuelve una vez, a quien invita, y no se puede volver a pedir: si se
 *     pierde, se reenvía y el anterior queda anulado.
 *   - El token va en el **fragmento** del enlace (`#...`), no en la ruta ni en
 *     la consulta. El navegador no manda el fragmento al servidor, así que no
 *     acaba en los registros de acceso de nadie, ni en la cabecera Referer.
 *   - Aceptar se hace bajo bloqueo de la fila: dos clics en el mismo enlace no
 *     pueden crear dos cuentas.
 *   - Invitar obedece la misma regla de rango que dar de alta: un encargado no
 *     puede invitar a otro encargado ni a un dueño. Ver `staff.js`.
 */

/** Cuánto vale un enlace. Una semana: lo que tarda alguien en ver un mensaje y sentarse a hacerlo. */
const TTL_DAYS = 7;

const RANK = { OWNER: 3, MANAGER: 2, CASHIER: 1, WAITER: 1 };

function assertMayAssign(actorRole, role) {
  if (actorRole === 'OWNER') return;
  if (!((RANK[actorRole] ?? 0) > (RANK[role] ?? 0))) {
    throw new ApiError('STAFF_ROLE_TOO_HIGH', 'You cannot grant a role at or above your own', {
      actorRole, role
    });
  }
}

const INVITATION_COLUMNS = 'id, restaurant_id, email, role, invited_by, created_at, expires_at';

/** El enlace que abre la pantalla de aceptar, con el token en el fragmento. */
function linkFor(token) {
  return `${config.onboarding.appBaseUrl}/invitacion#${token}`;
}

/**
 * ¿Se puede mandar el enlace por correo?
 *
 * El transporte `log` escribe el mensaje entero en el registro, enlace
 * incluido. En desarrollo es lo que permite probarlo; en producción sería
 * dejar una llave de entrada en los logs. Así que en producción, con `log`, no
 * se manda: quien invita comparte el enlace por su cuenta, que es lo que va a
 * hacer igual la mayoría (WhatsApp).
 */
function canEmail() {
  return !(process.env.NODE_ENV === 'production' && config.mail.transport === 'log');
}

async function sendInvitationEmail({ email, restaurantName, role, link }) {
  if (!canEmail()) return false;
  const roleLabel = { OWNER: 'dueño', MANAGER: 'encargado', CASHIER: 'caja', WAITER: 'mesero' }[role] ?? role;
  const result = await mailer.send({
    to: email,
    fromName: `${restaurantName} vía Splite`,
    subject: `Te invitaron al equipo de ${restaurantName}`,
    text: [
      `Hola:`,
      '',
      `${restaurantName} te invitó a su equipo en Splite, como ${roleLabel}.`,
      '',
      'Para entrar, abre este enlace y elige tu contraseña:',
      link,
      '',
      `El enlace sirve una sola vez y caduca en ${TTL_DAYS} días.`,
      'Si no esperabas esta invitación, ignora este correo: sin abrir el enlace no se crea nada.',
      '',
      'Este correo lo envía Splite y no recibe respuestas.'
    ].join('\n')
  });
  return Boolean(result?.sent);
}

/**
 * Invitar a una dirección con un rol.
 *
 * Devuelve el enlace **una vez**. Si ya había una invitación abierta para esa
 * dirección en este restaurante, se anula en la misma transacción: reenviar no
 * deja dos enlaces vivos.
 */
async function createInvitation({ restaurantId, actor, email, role, meta = {} }) {
  assertMayAssign(actor.role, role);

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);

  const { invitation, restaurantName } = await db.withTransaction(async client => {
    // Quien ya está en el equipo no se invita: se reactiva o se le cambia el rol.
    const existing = await client.query(
      'SELECT 1 FROM users WHERE restaurant_id = $1 AND lower(email) = lower($2)',
      [restaurantId, email]
    );
    if (existing.rows.length) {
      throw new ApiError('STAFF_EMAIL_TAKEN', 'Somebody here already uses that address', { email });
    }

    await client.query(
      `UPDATE staff_invitations SET revoked_at = now()
        WHERE restaurant_id = $1 AND lower(email) = lower($2)
          AND accepted_at IS NULL AND revoked_at IS NULL`,
      [restaurantId, email]
    );
    const { rows } = await client.query(
      `INSERT INTO staff_invitations (restaurant_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 * INTERVAL '1 day'))
       RETURNING ${INVITATION_COLUMNS}`,
      [restaurantId, email, role, tokenHash, actor.id, TTL_DAYS]
    );
    const name = await client.query('SELECT name FROM restaurants WHERE id = $1', [restaurantId]);
    return { invitation: rows[0], restaurantName: name.rows[0]?.name ?? 'Tu restaurante' };
  });

  const link = linkFor(token);

  await logAudit({
    ...meta,
    restaurantId,
    actorId: actor.id,
    action: 'STAFF_INVITED',
    resourceType: 'staff_invitation',
    resourceId: invitation.id,
    // Ni el token ni el enlace: el registro de auditoría lo leen más personas
    // que las que deberían poder entrar con él.
    details: { email, role }
  });

  // El correo no se espera para contestar ni puede tumbar la invitación: el
  // mailer nunca lanza, y si no sale, el enlace ya está en manos de quien invita.
  let emailed = false;
  try {
    emailed = await sendInvitationEmail({ email, restaurantName, role, link });
  } catch (err) {
    logger.warn({ event: 'STAFF_INVITATION_MAIL_FAILED', err }, 'Invitation email failed');
  }

  return { invitation, link, emailed };
}

/** Las invitaciones que siguen abiertas y sin caducar. */
async function listInvitations({ restaurantId }) {
  const { rows } = await db.query(
    `SELECT ${INVITATION_COLUMNS} FROM staff_invitations
      WHERE restaurant_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC`,
    [restaurantId]
  );
  return rows;
}

async function revokeInvitation({ restaurantId, actor, invitationId, meta = {} }) {
  const { rows } = await db.query(
    `SELECT id, role FROM staff_invitations
      WHERE id = $1 AND restaurant_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, restaurantId]
  );
  if (!rows.length) throw new ApiError('STAFF_INVITATION_NOT_FOUND', 'Invitation not found');
  // Anular es tan poderoso como invitar: quien no podría haberla hecho, no la deshace.
  assertMayAssign(actor.role, rows[0].role);

  await db.query('UPDATE staff_invitations SET revoked_at = now() WHERE id = $1 AND restaurant_id = $2',
    [invitationId, restaurantId]);
  await logAudit({
    ...meta,
    restaurantId,
    actorId: actor.id,
    action: 'STAFF_INVITATION_REVOKED',
    resourceType: 'staff_invitation',
    resourceId: invitationId,
    details: {}
  });
}

/**
 * Lo que la pantalla de aceptar necesita enseñar antes de pedir contraseña.
 *
 * Caducada, usada, anulada o inventada responden igual: no hay nada que ganar
 * diciéndole a quien prueba tokens cuál de las cuatro es.
 */
async function previewInvitation(token) {
  const { rows } = await db.query(
    `SELECT i.email, i.role, i.expires_at, r.name AS restaurant_name
       FROM staff_invitations i JOIN restaurants r ON r.id = i.restaurant_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > now()`,
    [hashToken(token)]
  );
  if (!rows.length) throw new ApiError('INVITATION_INVALID', 'This invitation is not valid anymore');
  return {
    email: rows[0].email,
    role: rows[0].role,
    restaurantName: rows[0].restaurant_name,
    expiresAt: new Date(rows[0].expires_at).toISOString()
  };
}

/**
 * Aceptar: crear la cuenta con la contraseña de la persona y entrar.
 *
 * Todo en una transacción con la invitación bloqueada. Si la dirección ya
 * tiene cuenta en Splite -- el correo identifica a una sola persona en todo el
 * sistema --, no se crea nada y la invitación sigue abierta, para que el dueño
 * pueda anularla e invitar otra dirección.
 */
async function acceptInvitation({ token, password, displayName = null, meta = {} }) {
  const passwordHash = await hashPassword(password);

  const { user, invitation, session } = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, restaurant_id, email, role FROM staff_invitations
        WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
        FOR UPDATE`,
      [hashToken(token)]
    );
    if (!rows.length) throw new ApiError('INVITATION_INVALID', 'This invitation is not valid anymore');
    const inv = rows[0];

    let created;
    try {
      const inserted = await client.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role, display_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, restaurant_id, email, role, display_name`,
        [inv.restaurant_id, inv.email, passwordHash, inv.role, displayName?.trim() || null]
      );
      created = inserted.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        throw new ApiError('INVITATION_EMAIL_IN_USE',
          'That address already has a Splite account; ask to be invited with another one');
      }
      throw err;
    }

    await client.query(
      'UPDATE staff_invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1',
      [inv.id, created.id]
    );
    const issued = await issueSession(created, meta, client);
    return { user: created, invitation: inv, session: issued };
  });

  await logAudit({
    ...meta,
    restaurantId: user.restaurant_id,
    actorId: user.id,
    action: 'STAFF_INVITATION_ACCEPTED',
    resourceType: 'user',
    resourceId: user.id,
    details: { invitationId: invitation.id, role: user.role }
  });

  return session;
}

module.exports = {
  TTL_DAYS, createInvitation, listInvitations, revokeInvitation,
  previewInvitation, acceptInvitation, linkFor
};
