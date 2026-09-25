const { test } = require('node:test');
const assert = require('node:assert/strict');

const billing = require('../src/services/platformBilling');
const operators = require('../src/services/operators');
const { signAccessToken, verifyAccessToken } = require('../src/utils/tokens');

const { addMonths, addDays, stateOf, monthlyValue } = billing._internals;

test('un mes más cae en el mismo día, o en el último si el mes es más corto', () => {
  assert.equal(addMonths('2026-01-15', 1), '2026-02-15');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2026-12-10', 1), '2027-01-10');
  assert.equal(addMonths('2026-03-31', 12), '2027-03-31');
  assert.equal(addDays('2026-02-26', 5), '2026-03-03');
});

test('la situación de un cliente: cancelado y suspendido ganan, la prueba es prueba', () => {
  const today = '2026-09-25';
  const base = { sub_status: 'ACTIVE', plan_tier: 'PRO', trial_ends_at: null, overdue: false };
  assert.equal(stateOf(base, today), 'ACTIVE');
  assert.equal(stateOf({ ...base, overdue: true }, today), 'OVERDUE');
  assert.equal(stateOf({ ...base, overdue: true, sub_status: 'SUSPENDED' }, today), 'SUSPENDED');
  assert.equal(stateOf({ ...base, sub_status: 'CANCELLED', plan_tier: 'TRIAL' }, today), 'CANCELLED');
  assert.equal(stateOf({ ...base, plan_tier: 'TRIAL', trial_ends_at: '2026-10-01T00:00:00Z', overdue: true }, today), 'TRIAL');
  assert.equal(stateOf({ ...base, plan_tier: 'TRIAL', trial_ends_at: '2026-09-01T00:00:00Z' }, today), 'TRIAL_EXPIRED');
});

test('un anual cuenta como un doceavo al mes', () => {
  assert.equal(monthlyValue(59000n, 'ANNUAL'), 4917n);
  assert.equal(monthlyValue(5900n, 'MONTHLY'), 5900n);
  assert.equal(monthlyValue(null, 'MONTHLY'), null);
});

test('una sesión de personal no se acepta como de operador, ni al revés', () => {
  const staff = signAccessToken({ id: '00000000-0000-4000-8000-000000000001', restaurantId: '00000000-0000-4000-8000-000000000002', role: 'OWNER' });
  assert.throws(() => operators.verifySession(staff));

  const op = operators.signSession({ id: '00000000-0000-4000-8000-000000000003', role: 'ADMIN' });
  assert.throws(() => verifyAccessToken(op));
  assert.equal(operators.verifySession(op).role, 'ADMIN');
});

test('el secreto del autenticador depende del operador y de su versión', () => {
  const { totpSecretFor } = operators._internals;
  const a = totpSecretFor({ id: 'a', totp_version: 1 });
  assert.equal(a, totpSecretFor({ id: 'a', totp_version: 1 }));
  assert.notEqual(a, totpSecretFor({ id: 'a', totp_version: 2 }), 'reset must invalidate the old authenticator');
  assert.notEqual(a, totpSecretFor({ id: 'b', totp_version: 1 }));
});
