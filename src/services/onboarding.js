const crypto = require('crypto');
const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const { hashToken } = require('../utils/tokens');
const { hashPassword, issueSession } = require('./auth');
const { normaliseRif, isValidRif, formatRif } = require('../utils/rif');
const { logAudit } = require('./audit');
const mailer = require('./mailer');
const { logger } = require('../connectors/logger');

/**
 * Restaurant registration: a reviewed lead, then an invitation.
 *
 *   1. submitLead   -- the public form. Records the lead and emails the
 *                      onboarding team. Creates no tenant and mints no token.
 *   2. inviteLead   -- after somebody has read the submission and telephoned
 *                      the restaurant. Mints the single-use link and sends it.
 *   3. verifySignup -- the restaurant sets its password, and only now do
 *                      `restaurants` and `users` come into existence.
 *
 * Step 1 used to do step 2's job automatically. It no longer does, because a
 * restaurant is qualified by a person: software that hands a tenant to whoever
 * fills in a form has not made that process faster, it has skipped it.
 *
 * Step 3 is unchanged, and the reason it exists is worth restating. Staff email
 * is globally unique (migration 002), so creating `users` before the address is
 * proven would let anyone permanently claim an address they cannot read. The
 * tenant is therefore still born inside the transaction that spends the token,
 * even though a human has already vouched for it -- being vouched for is not
 * the same as controlling the inbox.
 */

// A restaurant that has just been onboarded is in Venezuela and owes IVA.
// Migration 011 defaults both rates to 0 so that running it could not reprice an
// existing restaurant's open bills; a brand new one has no such history.
// Changeable afterwards through PATCH /menu/settings/charges.
const DEFAULT_VAT_BPS = 1600;
const DEFAULT_SERVICE_CHARGE_BPS = 1000;

function verificationUrl(token) {
  return `${config.onboarding.appBaseUrl}/registro/verificar?token=${encodeURIComponent(token)}`;
}

/**
 * Whether this address or tax id already belongs to a live tenant.
 *
 * Reported to the reviewer, not to the applicant. A duplicate is a thing for a
 * human to look at -- a second branch of the same group, an owner who forgot
 * they already signed up -- and not something the form should adjudicate.
 */
async function existingTenant(client, { email, rif }) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1)) AS email_taken,
            EXISTS (SELECT 1 FROM restaurants WHERE rif = $2)          AS rif_taken`,
    [email, rif]
  );
  return { emailTaken: rows[0].email_taken, rifTaken: rows[0].rif_taken };
}

/**
 * When the form was submitted, in the reader's own clock.
 *
 * Caracas rather than UTC, and spelled dd/mm rather than ISO, because the only
 * person who reads this line is deciding whether a restaurant that applied is
 * still worth telephoning this morning. In UTC an evening submission is dated
 * tomorrow, which is the same reason the dashboard's day window is Caracas --
 * see services/dashboard.js. Venezuela is UTC-04:00 year round, so there is no
 * daylight-saving edge to get wrong.
 */
function receivedAt(value) {
  if (!value) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('es-VE', {
    timeZone: 'America/Caracas',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).format(at);
}

function teamNotification(lead, duplicate) {
  const p = lead.profile || {};
  const received = receivedAt(lead.created_at);
  const flags = [
    duplicate.emailTaken ? 'ESE CORREO YA TIENE CUENTA' : null,
    duplicate.rifTaken ? 'ESE RIF YA ESTÁ REGISTRADO' : null,
    lead.rif_checksum_ok ? null : 'El dígito verificador del RIF no cuadra'
  ].filter(Boolean);

  return [
    `Restaurante:  ${lead.restaurant_name}`,
    `RIF:          ${formatRif(lead.rif)}`,
    `Contacto:     ${lead.email}`,
    `Teléfono:     ${lead.phone}`,
    `Moneda menú:  ${p.menuCurrency || 'VES'}`,
    // Omitted rather than printed as a dash when absent: this is the one field
    // nobody typed, so a placeholder would be reporting a gap in our own data
    // as though the restaurant had declined to answer.
    ...(received ? [`Recibido:     ${received}`] : []),
    '',
    `Mesas:        ${p.tableCount ?? '—'}`,
    `Personal:     ${p.staffCount ?? '—'}`,
    `Sistema hoy:  ${p.posSystem || '—'}`,
    `Cubiertos/mes:${p.monthlyCovers ?? '—'}`,
    '',
    'Notas del restaurante:',
    p.notes ? p.notes : '(sin notas)',
    '',
    ...(flags.length ? ['REVISAR:', ...flags.map(f => `  - ${f}`), ''] : []),
    `Lead id: ${lead.id}`,
    '',
    'Cuando lo hayan llamado y quieran darle acceso:',
    `  npm run onboarding -- invite ${lead.id}`
  ].join('\n');
}

/**
 * Step one: the public form.
 *
 * Answers the same thing to everyone. The applicant is never told whether their
 * address or RIF is already on file -- `/auth/login` goes to the trouble of a
 * decoy Argon2 hash so that response timing cannot enumerate accounts, and a
 * form that replied "you already have an account" would hand that back in
 * words. The duplicate goes to the reviewer instead.
 */
async function submitLead(input, meta = {}) {
  const rif = normaliseRif(input.rif);
  const email = String(input.email).toLowerCase();

  const duplicate = await existingTenant(db, { email, rif });

  const { rows } = await db.query(
    `INSERT INTO restaurant_signups
       (restaurant_name, rif, rif_checksum_ok, email, phone, profile, status, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'NEW', $7, $8)
     RETURNING id, restaurant_name, rif, rif_checksum_ok, email, phone, profile, created_at`,
    [
      input.restaurantName,
      rif,
      isValidRif(rif),
      email,
      input.phone,
      JSON.stringify({ ...(input.profile || {}), menuCurrency: input.menuCurrency }),
      meta.ip || null,
      meta.userAgent || null
    ]
  );
  const lead = rows[0];

  await logAudit({
    action: 'ONBOARDING_LEAD_SUBMITTED',
    resourceType: 'restaurant_signup',
    resourceId: lead.id,
    details: {
      restaurantName: lead.restaurant_name,
      rifChecksumOk: lead.rif_checksum_ok,
      duplicateEmail: duplicate.emailTaken,
      duplicateRif: duplicate.rifTaken
    },
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId
  });

  // To the team, so somebody can read it and pick up the phone. This is the
  // only notification that matters operationally; the applicant's is courtesy.
  await mailer.send({
    to: config.onboarding.teamEmail,
    subject: `Nuevo restaurante: ${lead.restaurant_name}`,
    text: teamNotification(lead, duplicate)
  });

  await mailer.send({
    to: email,
    subject: 'Recibimos tu solicitud — Splite',
    text: [
      `Hola, ${lead.restaurant_name}.`,
      '',
      'Recibimos tu solicitud para usar Splite. Un miembro de nuestro equipo',
      `revisará los datos y te llamará al ${lead.phone} para coordinar la puesta en marcha.`,
      '',
      'No hace falta que hagas nada más por ahora.',
      '',
      'Si no fuiste tú quien llenó el formulario, ignora este mensaje.'
    ].join('\n')
  });

  logger.info({ event: 'ONBOARDING_LEAD_SUBMITTED', leadId: lead.id }, 'New restaurant lead');

  return { status: 'RECEIVED', email };
}

/**
 * Step two: the team, having called, lets the restaurant in.
 *
 * Not an HTTP endpoint. Every authenticated surface in this API is scoped to a
 * restaurant -- `req.user.restaurantId` -- and there is no platform-operator
 * role to hang an internal endpoint off. Inventing one to serve a handful of
 * approvals a week would be a new authentication model to secure and maintain,
 * so this is reached through `npm run onboarding -- invite <id>` instead. If the
 * volume ever justifies an internal console, the console calls this function.
 */
async function inviteLead(leadId, meta = {}) {
  const token = crypto.randomBytes(32).toString('base64url');

  const lead = await db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT id, restaurant_name, rif, email, phone, status, consumed_at
         FROM restaurant_signups
        WHERE id = $1
          FOR UPDATE`,
      [leadId]
    );
    const found = rows[0];
    if (!found) throw new ApiError('NOT_FOUND', 'No such lead');
    if (found.consumed_at) throw new ApiError('NOT_FOUND', 'That lead has already been onboarded');

    const duplicate = await existingTenant(client, { email: found.email, rif: found.rif });
    if (duplicate.emailTaken) throw new ApiError('EMAIL_ALREADY_REGISTERED', 'That email already has an account');
    if (duplicate.rifTaken) throw new ApiError('RIF_ALREADY_REGISTERED', 'That RIF is already registered');

    // Re-inviting supersedes the previous link rather than adding a second one:
    // token_hash is overwritten, so only the newest invitation works.
    await client.query(
      `UPDATE restaurant_signups
          SET token_hash = $2,
              expires_at = NOW() + ($3 * INTERVAL '1 second'),
              status = 'INVITED',
              invited_at = NOW()
        WHERE id = $1`,
      [leadId, hashToken(token), config.onboarding.tokenTtlSeconds]
    );

    return found;
  });

  await logAudit({
    action: 'ONBOARDING_LEAD_INVITED',
    resourceType: 'restaurant_signup',
    resourceId: lead.id,
    details: { restaurantName: lead.restaurant_name },
    ...meta
  });

  const hours = Math.round(config.onboarding.tokenTtlSeconds / 3600);
  await mailer.send({
    to: lead.email,
    subject: 'Tu cuenta de Splite está lista para activar',
    text: [
      `Hola, ${lead.restaurant_name}.`,
      '',
      'Ya podemos activar tu cuenta. Entra aquí para elegir tu contraseña:',
      verificationUrl(token),
      '',
      `El enlace vence en ${hours} horas y solo se puede usar una vez.`
    ].join('\n')
  });

  logger.info({ event: 'ONBOARDING_LEAD_INVITED', leadId: lead.id }, 'Lead invited');

  return { id: lead.id, email: lead.email, restaurantName: lead.restaurant_name };
}

/**
 * Step three: the link is spent and the tenant is born, atomically.
 *
 * A failure anywhere in here -- a duplicate email that appeared since the
 * invitation, a lost connection -- leaves no half-built restaurant that its
 * owner can neither use nor register again.
 */
async function verifySignup(token, password, meta = {}) {
  // Outside the transaction on purpose: Argon2id at 19 MiB takes long enough
  // that hashing while holding the row lock would widen the window for nothing.
  const passwordHash = await hashPassword(password);

  const result = await db.withTransaction(async client => {
    // FOR UPDATE, so two clicks on the same link cannot both pass the
    // consumed_at check and create two restaurants.
    const { rows } = await client.query(
      `SELECT id, restaurant_name, rif, email, profile, expires_at, consumed_at
         FROM restaurant_signups
        WHERE token_hash = $1
          FOR UPDATE`,
      [hashToken(token)]
    );
    const signup = rows[0];

    // One code for absent, spent and expired: see src/errors.js.
    if (!signup || signup.consumed_at || !signup.expires_at
        || new Date(signup.expires_at) <= new Date()) {
      throw new ApiError('ONBOARDING_TOKEN_INVALID', 'This verification link is no longer valid');
    }

    const menuCurrency = signup.profile?.menuCurrency || 'VES';

    const restaurant = await client.query(
      `INSERT INTO restaurants
         (name, rif, menu_currency, vat_bps, service_charge_bps, plan_tier, trial_ends_at)
       VALUES ($1, $2, $3, $4, $5, 'TRIAL', NOW() + ($6 * INTERVAL '1 day'))
       RETURNING id, name, rif, menu_currency, vat_bps, service_charge_bps, plan_tier, trial_ends_at`,
      [
        signup.restaurant_name, signup.rif, menuCurrency,
        DEFAULT_VAT_BPS, DEFAULT_SERVICE_CHARGE_BPS, config.onboarding.trialDays
      ]
    );

    const user = await client.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER')
       RETURNING id, restaurant_id, email, role`,
      [restaurant.rows[0].id, signup.email, passwordHash]
    );

    await client.query(
      `UPDATE restaurant_signups
          SET consumed_at = NOW(), restaurant_id = $2, status = 'ONBOARDED'
        WHERE id = $1`,
      [signup.id, restaurant.rows[0].id]
    );

    // Signed in immediately. The address is proven and the password was chosen
    // in this same request, so a login screen here would only ask for what was
    // just typed.
    const session = await issueSession(user.rows[0], meta, client);

    return { restaurant: restaurant.rows[0], session };
  }).catch(err => {
    // Both uniques can only lose a race now -- inviteLead checked, and this is
    // the window between.
    if (err.code === '23505') {
      if (String(err.constraint || '').includes('rif')) {
        throw new ApiError('RIF_ALREADY_REGISTERED', 'That RIF is already registered');
      }
      throw new ApiError('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
    }
    throw err;
  });

  await logAudit({
    restaurantId: result.restaurant.id,
    actorId: result.session.user.id,
    action: 'ONBOARDING_COMPLETED',
    resourceType: 'restaurant',
    resourceId: result.restaurant.id,
    details: { plan: result.restaurant.plan_tier },
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId
  });

  logger.info(
    { event: 'RESTAURANT_ONBOARDED', restaurantId: result.restaurant.id },
    'Restaurant completed onboarding'
  );

  return result;
}

/** The team's queue, oldest first. Read by the CLI. */
async function listLeads({ status = null, limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT id, restaurant_name, rif, email, phone, status, rif_checksum_ok,
            created_at, invited_at, consumed_at
       FROM restaurant_signups
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at
      LIMIT $2`,
    [status, limit]
  );
  return rows;
}

/** Records that the lead was worked, so the queue reflects reality. */
async function markLead(leadId, status, reviewNotes = null) {
  const { rows } = await db.query(
    `UPDATE restaurant_signups
        SET status = $2,
            review_notes = COALESCE($3, review_notes),
            contacted_at = CASE WHEN $2 = 'CONTACTED' THEN NOW() ELSE contacted_at END
      WHERE id = $1
      RETURNING id, status`,
    [leadId, status, reviewNotes]
  );
  if (!rows.length) throw new ApiError('NOT_FOUND', 'No such lead');
  return rows[0];
}

module.exports = {
  submitLead,
  // Exported for tests. The Caracas conversion is the part worth pinning: it is
  // invisible in the output and wrong only for four hours a day.
  teamNotification,
  inviteLead,
  verifySignup,
  listLeads,
  markLead,
  verificationUrl,
  DEFAULT_VAT_BPS,
  DEFAULT_SERVICE_CHARGE_BPS
};
