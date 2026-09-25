const crypto = require('crypto');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');

const config = require('../config');
const db = require('../connectors/base');
const { ApiError } = require('../errors');
const { hashToken } = require('../utils/tokens');
const totp = require('./totp');
const loginThrottle = require('./loginThrottle');
const { ARGON2_OPTIONS } = require('./auth');

/**
 * Las personas de Splite que usan la consola.
 *
 * No son usuarios de ningún restaurante y no comparten nada con ellos: tabla
 * propia, contraseña propia, segundo factor **obligatorio** desde el alta y una
 * sesión firmada con otra clave y otra audiencia. Una sesión de restaurante no
 * abre la consola y una de operador no abre el panel de un restaurante; lo
 * comprueban las pruebas en las dos direcciones.
 *
 * ## Ningún secreto guardado
 *
 * El secreto TOTP no se guarda: se deriva del secreto del servidor, del id del
 * operador y de su versión, igual que las firmas de las conexiones con el
 * banco. Una copia de la base no permite generar códigos, y volver a dar de
 * alta a alguien -- un teléfono perdido -- es subir la versión, que deja sin
 * valor el autenticador anterior. La clave de sesión también se deriva, con
 * otra etiqueta, así que no hay una variable de entorno más que configurar.
 */

const ROLES = ['ADMIN', 'SUPPORT'];

/** Horas que vale el enlace de alta. */
const SETUP_TTL_HOURS = 72;

/** Una sesión de consola dura una jornada, no una semana. Sin refresco: se vuelve a entrar. */
const SESSION_TTL_SECONDS = 8 * 60 * 60;

const AUDIENCE = 'splite-operator';

const derive = label =>
  crypto.createHmac('sha256', config.jwt.accessSecret).update(label).digest();

function sessionKey() {
  return derive('platform-operator-session:v1');
}

function totpSecretFor(operator) {
  const raw = derive(`platform-operator-totp:v${operator.totp_version}:${operator.id}`);
  return totp.base32Encode(raw.subarray(0, 20));
}

const COLUMNS = `id, email, display_name, role, password_hash, totp_version, totp_last_step,
                 setup_expires_at, activated_at, active, last_login_at, created_at`;

/** Lo que se puede enseñar de un operador. Nunca el hash ni el token. */
function view(op) {
  return {
    id: op.id,
    email: op.email,
    displayName: op.display_name,
    role: op.role,
    active: op.active,
    activated: Boolean(op.activated_at),
    lastLoginAt: op.last_login_at ? new Date(op.last_login_at).toISOString() : null
  };
}

function signSession(op) {
  return jwt.sign(
    { sub: op.id, role: op.role, type: 'operator' },
    sessionKey(),
    { issuer: config.jwt.issuer, audience: AUDIENCE, expiresIn: SESSION_TTL_SECONDS, algorithm: 'HS256' }
  );
}

function verifySession(token) {
  const claims = jwt.verify(token, sessionKey(), {
    issuer: config.jwt.issuer, audience: AUDIENCE, algorithms: ['HS256']
  });
  if (claims.type !== 'operator' || !claims.sub || !ROLES.includes(claims.role)) {
    throw new Error('Not an operator session');
  }
  return claims;
}

function newSetupToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

async function audit(client, { operatorId, action, restaurantId = null, resourceType = null,
  resourceId = null, details = null, meta = {} }) {
  await client.query(
    `INSERT INTO operator_audit
       (operator_id, action, restaurant_id, resource_type, resource_id, details, ip, user_agent, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [operatorId, action, restaurantId, resourceType, resourceId,
      details ? JSON.stringify(details) : null,
      meta.ip || null, meta.userAgent ? String(meta.userAgent).slice(0, 512) : null, meta.requestId || null]
  );
}

/**
 * Dar de alta a alguien. Devuelve el enlace de un solo uso; la persona elige su
 * contraseña y vincula su autenticador al abrirlo. Sólo desde la línea de
 * comandos: la consola no crea operadores, para que una sesión robada no pueda
 * fabricarse otra.
 */
async function createOperator({ email, displayName, role }) {
  if (!ROLES.includes(role)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown role ${role}`, { allowed: ROLES });
  }
  const { token, hash } = newSetupToken();
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `INSERT INTO platform_operators (email, display_name, role, setup_token_hash, setup_expires_at)
       VALUES ($1, $2, $3, $4, NOW() + ($5::INT * INTERVAL '1 hour'))
       RETURNING ${COLUMNS}`,
      [email, displayName, role, hash, SETUP_TTL_HOURS]
    ).catch(err => {
      if (err.code === '23505') throw new ApiError('OPERATOR_EMAIL_TAKEN', 'An operator with that email already exists');
      throw err;
    });
    await audit(client, { operatorId: null, action: 'OPERATOR_CREATED', resourceType: 'operator',
      resourceId: rows[0].id, details: { email, role, via: 'cli' } });
    return { operator: view(rows[0]), token };
  });
}

/**
 * Volver a dar de alta: contraseña y autenticador nuevos. Es lo que se hace
 * cuando alguien pierde el teléfono. El autenticador viejo deja de valer.
 */
async function resetOperator({ email }) {
  const { token, hash } = newSetupToken();
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `UPDATE platform_operators
          SET password_hash = NULL, activated_at = NULL, totp_version = totp_version + 1,
              totp_last_step = NULL, setup_token_hash = $2,
              setup_expires_at = NOW() + ($3::INT * INTERVAL '1 hour'), updated_at = NOW()
        WHERE email = $1
      RETURNING ${COLUMNS}`,
      [email, hash, SETUP_TTL_HOURS]
    );
    if (!rows.length) throw new ApiError('OPERATOR_NOT_FOUND', 'Operator not found');
    await audit(client, { operatorId: null, action: 'OPERATOR_RESET', resourceType: 'operator',
      resourceId: rows[0].id, details: { via: 'cli' } });
    return { operator: view(rows[0]), token };
  });
}

async function setActive({ email, active }) {
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `UPDATE platform_operators SET active = $2, updated_at = NOW() WHERE email = $1 RETURNING ${COLUMNS}`,
      [email, active]
    );
    if (!rows.length) throw new ApiError('OPERATOR_NOT_FOUND', 'Operator not found');
    await audit(client, { operatorId: null, action: active ? 'OPERATOR_ENABLED' : 'OPERATOR_DISABLED',
      resourceType: 'operator', resourceId: rows[0].id, details: { via: 'cli' } });
    return view(rows[0]);
  });
}

async function listOperators() {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM platform_operators ORDER BY created_at`);
  return rows.map(view);
}

async function findBySetupToken(client, token) {
  const { rows } = await client.query(
    `SELECT ${COLUMNS} FROM platform_operators
      WHERE setup_token_hash = $1 AND setup_expires_at > NOW() AND active
      FOR UPDATE`,
    [hashToken(String(token || ''))]
  );
  // Caducado, usado o inventado: la misma respuesta.
  if (!rows.length) throw new ApiError('OPERATOR_SETUP_INVALID', 'This setup link is not valid');
  return rows[0];
}

/** Primer paso del alta: lo que el autenticador necesita. Se puede repetir. */
async function setupStart({ token }) {
  const op = await db.withTransaction(client => findBySetupToken(client, token));
  const secret = totpSecretFor(op);
  return {
    email: op.email,
    displayName: op.display_name,
    secret,
    otpauthUri: totp.otpauthUri({ secret, account: op.email, issuer: 'Splite Consola' })
  };
}

/** Segundo paso: contraseña y un código que demuestre que el autenticador quedó vinculado. */
async function setupComplete({ token, password, code, meta = {} }) {
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  const op = await db.withTransaction(async client => {
    const pending = await findBySetupToken(client, token);
    const match = totp.verify(totpSecretFor(pending), code);
    if (!match) throw new ApiError('MFA_CODE_INVALID', 'That code is not valid');
    const { rows } = await client.query(
      `UPDATE platform_operators
          SET password_hash = $2, activated_at = NOW(), totp_last_step = $3,
              setup_token_hash = NULL, setup_expires_at = NULL, last_login_at = NOW(), updated_at = NOW()
        WHERE id = $1
      RETURNING ${COLUMNS}`,
      [pending.id, passwordHash, match.step]
    );
    await audit(client, { operatorId: pending.id, action: 'OPERATOR_ACTIVATED', resourceType: 'operator',
      resourceId: pending.id, meta });
    return rows[0];
  });
  return { accessToken: signSession(op), expiresIn: SESSION_TTL_SECONDS, operator: view(op) };
}

let decoy;
const decoyHash = () => {
  decoy = decoy || argon2.hash(crypto.randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return decoy;
};

/**
 * Entrar: correo, contraseña y código, en una sola petición.
 *
 * Todo fallo es el mismo `INVALID_CREDENTIALS` -- correo desconocido,
 * contraseña mala, código malo, cuenta sin activar o desactivada -- para que la
 * respuesta no sirva para averiguar qué correos son de operadores. Los intentos
 * cuentan en el mismo limitador que el login del personal, con su propia clave.
 */
async function login({ email, password, code, meta = {} }) {
  const throttleKey = `operator:${String(email || '').toLowerCase()}`;
  await loginThrottle.assertNotThrottled(throttleKey);

  const { rows } = await db.query(`SELECT ${COLUMNS} FROM platform_operators WHERE email = $1`, [email]);
  const op = rows[0];
  const passwordOk = op && op.password_hash
    ? await argon2.verify(op.password_hash, password).catch(() => false)
    : await argon2.verify(await decoyHash(), password).catch(() => false);

  const fail = async () => {
    await loginThrottle.recordFailure(throttleKey);
    throw new ApiError('INVALID_CREDENTIALS', 'Invalid credentials');
  };
  if (!op || !op.active || !op.activated_at || !passwordOk) return fail();

  const match = totp.verify(totpSecretFor(op), code, {
    notBeforeStep: op.totp_last_step === null ? null : Number(op.totp_last_step)
  });
  if (!match) return fail();

  // El mismo código no vale dos veces: sólo avanza si nadie lo usó antes.
  const updated = await db.withTransaction(async client => {
    const { rows: done } = await client.query(
      `UPDATE platform_operators SET totp_last_step = $2, last_login_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)
      RETURNING ${COLUMNS}`,
      [op.id, match.step]
    );
    if (!done.length) return null;
    await audit(client, { operatorId: op.id, action: 'OPERATOR_LOGIN', resourceType: 'operator',
      resourceId: op.id, meta });
    return done[0];
  });
  if (!updated) return fail();

  await loginThrottle.clearFailures(throttleKey);
  return { accessToken: signSession(updated), expiresIn: SESSION_TTL_SECONDS, operator: view(updated) };
}

/** Quién es, releído: un operador desactivado deja de entrar aunque su sesión no haya caducado. */
async function current(operatorId) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM platform_operators WHERE id = $1`, [operatorId]);
  const op = rows[0];
  if (!op || !op.active || !op.activated_at) {
    throw new ApiError('AUTH_TOKEN_INVALID', 'Operator inactive');
  }
  return op;
}

function setupLink(token) {
  return `${config.appBaseUrl.replace(/\/$/, '')}/admin/alta#${token}`;
}

module.exports = {
  ROLES, SETUP_TTL_HOURS, SESSION_TTL_SECONDS, AUDIENCE,
  createOperator, resetOperator, setActive, listOperators,
  setupStart, setupComplete, login, current, audit, view,
  signSession, verifySession, setupLink,
  _internals: { totpSecretFor, sessionKey }
};
