#!/usr/bin/env node

const db = require('../src/connectors/base');
const config = require('../src/config');
const mailer = require('../src/services/mailer');
const onboarding = require('../src/services/onboarding');
const { formatRif } = require('../src/utils/rif');

/**
 * The onboarding team's queue.
 *
 *   npm run onboarding -- list [status]
 *   npm run onboarding -- show <id>
 *   npm run onboarding -- contacted <id> [notes...]
 *   npm run onboarding -- invite <id>
 *   npm run onboarding -- reject <id> [notes...]
 *   npm run onboarding -- test-mail [address]
 *
 * A command line rather than an internal API because every authenticated
 * surface in this app is scoped to a restaurant the caller belongs to, and
 * there is no platform-operator role. Adding one to serve a handful of
 * approvals a week would be a second authentication model to secure, review and
 * keep correct forever. If the volume ever justifies a console, the console
 * calls the same functions in src/services/onboarding.js that this does.
 *
 * `invite` is the only destructive one: it mails a single-use link that lets
 * the recipient create a tenant. Re-running it supersedes the previous link
 * rather than issuing a second working one.
 */

const STATUSES = ['NEW', 'CONTACTED', 'INVITED', 'ONBOARDED', 'REJECTED'];

function pad(value, width) {
  return String(value ?? '—').padEnd(width).slice(0, width);
}

async function list(status) {
  if (status && !STATUSES.includes(status)) {
    throw new Error(`Unknown status ${status}. One of: ${STATUSES.join(', ')}`);
  }
  const leads = await onboarding.listLeads({ status: status || null });
  if (!leads.length) {
    console.log(status ? `No leads with status ${status}.` : 'No leads.');
    return;
  }

  console.log(`${pad('ID', 38)}${pad('ESTADO', 11)}${pad('RESTAURANTE', 26)}${pad('TELÉFONO', 18)}RECIBIDO`);
  for (const lead of leads) {
    console.log(
      pad(lead.id, 38) +
      pad(lead.status, 11) +
      pad(lead.restaurant_name, 26) +
      pad(lead.phone, 18) +
      new Date(lead.created_at).toISOString().slice(0, 16).replace('T', ' ')
    );
  }
  console.log(`\n${leads.length} lead(s).`);
}

async function show(id) {
  const { rows } = await db.query('SELECT * FROM restaurant_signups WHERE id = $1', [id]);
  if (!rows.length) throw new Error('No such lead');
  const lead = rows[0];
  const p = lead.profile || {};

  console.log([
    `Restaurante:  ${lead.restaurant_name}`,
    `RIF:          ${formatRif(lead.rif)}${lead.rif_checksum_ok ? '' : '   (dígito verificador no cuadra)'}`,
    `Contacto:     ${lead.email}`,
    `Teléfono:     ${lead.phone}`,
    `Estado:       ${lead.status}`,
    `Recibido:     ${lead.created_at.toISOString()}`,
    lead.contacted_at ? `Contactado:   ${lead.contacted_at.toISOString()}` : null,
    lead.invited_at ? `Invitado:     ${lead.invited_at.toISOString()}` : null,
    lead.consumed_at ? `Activado:     ${lead.consumed_at.toISOString()}` : null,
    '',
    `Moneda menú:  ${p.menuCurrency || 'VES'}`,
    `Mesas:        ${p.tableCount ?? '—'}`,
    `Personal:     ${p.staffCount ?? '—'}`,
    `Sistema hoy:  ${p.posSystem || '—'}`,
    `Cubiertos/mes: ${p.monthlyCovers ?? '—'}`,
    '',
    'Notas del restaurante:',
    p.notes || '(sin notas)',
    lead.review_notes ? `\nNotas internas:\n${lead.review_notes}` : ''
  ].filter(l => l !== null).join('\n'));
}

/**
 * Proves the mail path, before a real restaurant depends on it.
 *
 * `mailer.send` never throws -- a provider outage must not fail the request
 * that triggered it -- so a wrong app password or an unverified sender produces
 * a lead that is recorded, a 202 that looks fine, and a notification nobody
 * receives. The failure has no symptom at the place it happens, which is why
 * there is a command whose whole job is to make it produce one.
 *
 * Sends to ONBOARDING_TEAM_EMAIL unless given an address, and exits non-zero
 * when the send fails, so it can gate a deploy.
 */
async function testMail(address) {
  const to = address || config.onboarding.teamEmail;
  const { transport, from } = config.mail;

  console.log(`Transporte:   ${transport}`);
  console.log(`Remitente:    ${from}`);
  console.log(`Destinatario: ${to}`);
  if (transport === 'log') {
    console.log('\nMAIL_TRANSPORT=log no envía nada: escribe el mensaje en el log.');
  }
  console.log('');

  const stamp = new Date().toISOString();
  const result = await mailer.send({
    to,
    subject: 'Prueba de correo — Splite',
    text: [
      'Esto es una prueba del envío de correo de Splite.',
      '',
      `Transporte: ${transport}`,
      `Enviado:    ${stamp}`,
      '',
      'Si recibiste este mensaje, las notificaciones de nuevos restaurantes',
      'llegarán a esta dirección.'
    ].join('\n')
  });

  // Closed here rather than left to the process: a pooled SMTP connection is an
  // open socket, and a CLI that holds one never exits.
  mailer.closeTransport();

  if (!result.sent) {
    console.error(`No se pudo enviar: ${result.error || 'motivo desconocido'}`);
    if (/535|credentials|password/i.test(result.error || '')) {
      console.error('\nGmail rechaza la contraseña de la cuenta. MAIL_SMTP_PASSWORD tiene que');
      console.error('ser una contraseña de aplicación de 16 caracteres, generada en');
      console.error('myaccount.google.com con la verificación en dos pasos activada.');
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Enviado por ${result.transport}${result.id ? ` (${result.id})` : ''}.`);
  if (transport !== 'log') console.log(`Revisa ${to}, incluida la carpeta de spam.`);
}

async function invite(id) {
  const lead = await onboarding.inviteLead(id);
  console.log(`Invitación enviada a ${lead.email} (${lead.restaurantName}).`);
  console.log('El enlace es de un solo uso. Reenviarlo invalida el anterior.');
}

async function mark(id, status, notes) {
  const lead = await onboarding.markLead(id, status, notes || null);
  console.log(`Lead ${lead.id} → ${lead.status}`);
}

async function run() {
  const [command, id, ...rest] = process.argv.slice(2);
  const notes = rest.join(' ') || null;

  switch (command) {
    case 'list': return list(id);
    case 'show': return show(requireId(id));
    case 'invite': return invite(requireId(id));
    case 'contacted': return mark(requireId(id), 'CONTACTED', notes);
    case 'reject': return mark(requireId(id), 'REJECTED', notes);
    // `id` is the positional argument; here it is an optional address.
    case 'test-mail': return testMail(id);
    default:
      console.log([
        'Uso:',
        '  npm run onboarding -- list [NEW|CONTACTED|INVITED|ONBOARDED|REJECTED]',
        '  npm run onboarding -- show <id>',
        '  npm run onboarding -- contacted <id> [notas...]',
        '  npm run onboarding -- invite <id>',
        '  npm run onboarding -- reject <id> [notas...]',
        '  npm run onboarding -- test-mail [dirección]'
      ].join('\n'));
      process.exitCode = 1;
  }
}

function requireId(id) {
  if (!id) throw new Error('This command needs a lead id. Run `list` to find one.');
  return id;
}

run()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
