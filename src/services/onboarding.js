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
 * Self-service restaurant registration.
 *
 * Two steps, and the split between them is the security property rather than a
 * UX preference:
 *
 *   1. requestSignup  -- records an *intent* and mails a link. Creates no
 *                        tenant, no user, no credential.
 *   2. verifySignup   -- consumes the link, and only now creates
 *                        restaurant + owner + menu defaults, in one transaction.
 *
 * See migrations/012 for why the tenant cannot be created in step 1: staff email
 * is globally unique, so an unverified insert into `users` permanently claims an
 * address the registrant may not own.
 */

// A restaurant that has just registered is in Venezuela and owes IVA. Migration
// 011 defaults both rates to 0 so that running it could not reprice an existing
// restaurant's open bills; a brand new one has no such history and gets the real
// numbers. Both are changeable afterwards through PATCH /menu/settings/charges.
const DEFAULT_VAT_BPS = 1600;
const DEFAULT_SERVICE_CHARGE_BPS = 1000;

function verificationUrl(token) {
  return `${config.onboarding.appBaseUrl}/registro/verificar?token=${encodeURIComponent(token)}`;
}

/**
 * Whether this address or tax id is already spoken for.
 *
 * Checked against live tenants only. A pending signup for the same address is
 * not a conflict -- resubmitting the form is how somebody who lost the email
 * gets another one.
 */
async function alreadyRegistered(client, { email, rif }) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1)) AS email_taken,
            EXISTS (SELECT 1 FROM restaurants WHERE rif = $2)          AS rif_taken`,
    [email, rif]
  );
  return { emailTaken: rows[0].email_taken, rifTaken: rows[0].rif_taken };
}

/**
 * Step one. Always reports the same outcome.
 *
 * The response cannot depend on whether the address is already registered.
 * `login` goes to the trouble of verifying an unknown address against a decoy
 * Argon2 hash purely so that response *timing* cannot be used to enumerate
 * accounts (src/services/auth.js); an endpoint that answered "that email is
 * taken" would hand back the same oracle in plain words, and this one is
 * reachable without any credential at all.
 *
 * So both branches mail something and return the same body. Someone whose
 * address is already registered gets told that an account exists and how to
 * recover it, which is information they are entitled to and an attacker who
 * merely guessed the address never sees.
 */
async function requestSignup(input, meta = {}) {
  const rif = normaliseRif(input.rif);
  const email = String(input.email).toLowerCase();

  const { emailTaken, rifTaken } = await alreadyRegistered(db, { email, rif });

  if (emailTaken || rifTaken) {
    await logAudit({
      action: 'ONBOARDING_SIGNUP_REJECTED_SILENTLY',
      resourceType: 'restaurant_signup',
      details: { reason: emailTaken ? 'EMAIL_TAKEN' : 'RIF_TAKEN' },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId
    });

    await mailer.send({
      to: email,
      subject: 'Alguien intentó registrar tu restaurante en Splite',
      text: [
        'Recibimos una solicitud para registrar un restaurante con esta dirección,',
        'pero ya existe una cuenta asociada a ella.',
        '',
        emailTaken
          ? 'Si fuiste tú, inicia sesión con tu contraseña habitual.'
          : `El RIF ${formatRif(rif)} ya está registrado por otra cuenta.`,
        '',
        'Si no fuiste tú, puedes ignorar este mensaje: no se creó nada.'
      ].join('\n')
    });

    return { status: 'PENDING_VERIFICATION', email };
  }

  const token = crypto.randomBytes(32).toString('base64url');

  await db.withTransaction(async client => {
    // Supersede any link already outstanding for this address, so that
    // resubmitting the form leaves exactly one working link rather than a
    // growing set of them.
    await client.query(
      `UPDATE restaurant_signups
          SET expires_at = NOW()
        WHERE lower(email) = lower($1) AND consumed_at IS NULL AND expires_at > NOW()`,
      [email]
    );

    await client.query(
      `INSERT INTO restaurant_signups
         (restaurant_name, rif, rif_checksum_ok, email, profile, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW() + ($7 * INTERVAL '1 second'), $8, $9)`,
      [
        input.restaurantName,
        rif,
        isValidRif(rif),
        email,
        JSON.stringify({ ...(input.profile || {}), menuCurrency: input.menuCurrency }),
        hashToken(token),
        config.onboarding.tokenTtlSeconds,
        meta.ip || null,
        meta.userAgent || null
      ]
    );
  });

  await logAudit({
    action: 'ONBOARDING_SIGNUP_REQUESTED',
    resourceType: 'restaurant_signup',
    details: { restaurantName: input.restaurantName, rifChecksumOk: isValidRif(rif) },
    ip: meta.ip,
    userAgent: meta.userAgent,
    requestId: meta.requestId
  });

  const hours = Math.round(config.onboarding.tokenTtlSeconds / 3600);
  await mailer.send({
    to: email,
    subject: 'Confirma tu registro en Splite',
    text: [
      `Hola, ${input.restaurantName}.`,
      '',
      'Para terminar de crear tu cuenta y elegir tu contraseña, entra aquí:',
      verificationUrl(token),
      '',
      `El enlace vence en ${hours} horas y solo se puede usar una vez.`,
      'Si no solicitaste esto, ignora este mensaje: todavía no se creó ninguna cuenta.'
    ].join('\n')
  });

  return { status: 'PENDING_VERIFICATION', email };
}

/**
 * Step two: the link is spent and the tenant is born, atomically.
 *
 * Everything happens inside one transaction, so a failure anywhere -- a
 * duplicate email that appeared since step one, a bad password hash, a lost
 * connection -- leaves no half-built restaurant that its owner can neither use
 * nor register again.
 */
async function verifySignup(token, password, meta = {}) {
  const passwordHash = await hashPassword(password);

  const result = await db.withTransaction(async client => {
    // FOR UPDATE, so two clicks on the same link cannot both pass the
    // consumed_at check and create two restaurants. The second waits here and
    // then sees the row the first one consumed.
    const { rows } = await client.query(
      `SELECT id, restaurant_name, rif, email, profile, expires_at, consumed_at
         FROM restaurant_signups
        WHERE token_hash = $1
          FOR UPDATE`,
      [hashToken(token)]
    );
    const signup = rows[0];

    // One code for absent, spent and expired: see src/errors.js.
    if (!signup || signup.consumed_at || new Date(signup.expires_at) <= new Date()) {
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
      `UPDATE restaurant_signups SET consumed_at = NOW(), restaurant_id = $2 WHERE id = $1`,
      [signup.id, restaurant.rows[0].id]
    );

    // Signed in immediately. The address is proven and the password was chosen
    // in this same request, so a login screen here would only ask for what was
    // just typed.
    const session = await issueSession(user.rows[0], meta, client);

    return { restaurant: restaurant.rows[0], session };
  }).catch(err => {
    // Both uniques can only lose a race now -- step one checked, and this is
    // the window between. Reported honestly rather than as a 500, because the
    // caller at this point has proven the address and deserves to know which
    // half of their registration is the problem.
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
    'Restaurant completed self-service onboarding'
  );

  return result;
}

module.exports = {
  requestSignup,
  verifySignup,
  verificationUrl,
  DEFAULT_VAT_BPS,
  DEFAULT_SERVICE_CHARGE_BPS
};
