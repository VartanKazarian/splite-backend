const { test } = require('node:test');
const assert = require('node:assert/strict');
const { teamNotification } = require('../src/services/onboarding');

/**
 * The email somebody reads before telephoning a restaurant.
 *
 * Worth its own tests because every field in it came off a form that a stranger
 * filled in and will not fill in again: a lead misread is a lead lost, and the
 * notification is the only place most of this data is ever looked at.
 */
const LEAD = {
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  restaurant_name: 'La Casa del Pescador',
  // Typed without dashes; the notification reformats it.
  rif: 'J123456789',
  rif_checksum_ok: true,
  email: 'gerencia@casadelpescador.com',
  phone: '0412-5551234',
  created_at: '2026-08-22T16:34:52.074Z',
  profile: {
    menuCurrency: 'VES', tableCount: 18, staffCount: 12,
    posSystem: 'Cuaderno', monthlyCovers: 2400, notes: 'Abrimos de martes a domingo.'
  }
};
const CLEAN = { emailTaken: false, rifTaken: false };

test('every field the form collects reaches the notification', () => {
  const body = teamNotification(LEAD, CLEAN);

  assert.match(body, /Restaurante:\s+La Casa del Pescador/);
  // Reformatted from what was typed, so a reviewer reads a RIF rather than a string.
  assert.match(body, /RIF:\s+J-12345678-9/);
  assert.match(body, /Contacto:\s+gerencia@casadelpescador\.com/);
  assert.match(body, /Teléfono:\s+0412-5551234/);
  assert.match(body, /Moneda menú:\s+VES/);
  assert.match(body, /Mesas:\s+18/);
  assert.match(body, /Personal:\s+12/);
  assert.match(body, /Sistema hoy:\s+Cuaderno/);
  assert.match(body, /Cubiertos\/mes:\s*2400/);
  assert.match(body, /Abrimos de martes a domingo\./);
  // The next action, with the id already substituted.
  assert.match(body, /npm run onboarding -- invite 7c9e6679-7425-40de-944b-e07fc1f90ae7/);
});

test('the received time is Caracas, not UTC', () => {
  // 16:34 UTC is 12:34 the same day in Caracas.
  assert.match(teamNotification(LEAD, CLEAN), /Recibido:\s+22\/08\/2026, 12:34/);
});

test('an evening submission is not dated tomorrow', () => {
  // 01:15 UTC on the 23rd is 21:15 on the 22nd in Caracas. Printing the UTC
  // date would tell whoever picks up the phone that a lead which arrived during
  // last night's service came in today -- and four hours of every evening would
  // be filed under the wrong day.
  const body = teamNotification({ ...LEAD, created_at: '2026-08-23T01:15:00.000Z' }, CLEAN);

  assert.match(body, /Recibido:\s+22\/08\/2026, 21:15/);
  assert.doesNotMatch(body, /23\/08\/2026/);
});

test('a row with no timestamp omits the line rather than inventing one', () => {
  const body = teamNotification({ ...LEAD, created_at: null }, CLEAN);

  assert.doesNotMatch(body, /Recibido:/);
  // and the rest of the notification is unaffected
  assert.match(body, /Restaurante:\s+La Casa del Pescador/);
});

test('what a reviewer must not miss is called out separately', () => {
  const body = teamNotification({ ...LEAD, rif_checksum_ok: false }, { emailTaken: true, rifTaken: false });

  assert.match(body, /REVISAR:/);
  assert.match(body, /ESE CORREO YA TIENE CUENTA/);
  assert.match(body, /El dígito verificador del RIF no cuadra/);
  // The RIF is not registered, so that flag must not appear.
  assert.doesNotMatch(body, /ESE RIF YA ESTÁ REGISTRADO/);
});

test('a clean lead carries no warnings at all', () => {
  const body = teamNotification(LEAD, CLEAN);

  assert.doesNotMatch(body, /REVISAR/);
  assert.doesNotMatch(body, /dígito verificador/);
});

test('unanswered optional fields read as unanswered, not as zero', () => {
  const body = teamNotification({ ...LEAD, profile: { menuCurrency: 'USD' } }, CLEAN);

  assert.match(body, /Mesas:\s+—/);
  assert.match(body, /Personal:\s+—/);
  assert.match(body, /Sistema hoy:\s+—/);
  assert.match(body, /\(sin notas\)/);
  assert.match(body, /Moneda menú:\s+USD/);
});
