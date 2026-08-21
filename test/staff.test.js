const { test } = require('node:test');
const assert = require('node:assert/strict');

const { outranks, RANK } = require('../src/services/staff');
const {
  createStaffSchema, updateStaffSchema, resetStaffPasswordSchema
} = require('../src/middleware/schemas');

/**
 * Who may act on whom.
 *
 * The rank rule is the whole authorisation model for staff administration, and
 * it is a pure function, so it is tested as one -- every pair, rather than the
 * three or four a route test would happen to exercise.
 */

test('an owner may act on anybody, including another owner', () => {
  // A restaurant with two owners and one of them leaving is an ordinary
  // Tuesday. The self-check, not the rank check, is what stops an owner
  // removing themselves.
  for (const role of Object.keys(RANK)) {
    assert.equal(outranks('OWNER', role), true, `OWNER -> ${role}`);
  }
});

test('a manager may act below themselves and nowhere else', () => {
  assert.equal(outranks('MANAGER', 'CASHIER'), true);
  assert.equal(outranks('MANAGER', 'WAITER'), true);
  // A peer is not below you. Without this, any manager can remove every other
  // manager, and the first argument between two of them settles it.
  assert.equal(outranks('MANAGER', 'MANAGER'), false);
  assert.equal(outranks('MANAGER', 'OWNER'), false);
});

test('a cashier and a waiter outrank nobody', () => {
  for (const actor of ['CASHIER', 'WAITER']) {
    for (const target of Object.keys(RANK)) {
      assert.equal(outranks(actor, target), false, `${actor} -> ${target}`);
    }
  }
});

test('an unknown role outranks nobody and is outranked by everyone but an owner', () => {
  // Defensive rather than reachable: the column has a CHECK constraint. But
  // rank arithmetic on `undefined` is how a missing case becomes permission.
  assert.equal(outranks('CHEF', 'WAITER'), false);
  assert.equal(outranks('MANAGER', 'CHEF'), true);
});

test('a new account takes the same password rule as registration', () => {
  // It signs in through the same door, so a shorter password here would be a
  // quieter way into the same building.
  const base = { email: 'new@example.com', role: 'CASHIER' };
  assert.ok(createStaffSchema.validate({ ...base, password: 'short' }).error);
  assert.equal(createStaffSchema.validate({ ...base, password: 'a-long-enough-password' }).error, undefined);
  assert.ok(resetStaffPasswordSchema.validate({ password: 'short' }).error);
});

test('a role is required and cannot be invented', () => {
  const base = { email: 'new@example.com', password: 'a-long-enough-password' };
  assert.ok(createStaffSchema.validate(base).error, 'what they may do is the point of creating them');
  assert.ok(createStaffSchema.validate({ ...base, role: 'ADMIN' }).error);
  assert.equal(createStaffSchema.validate({ ...base, role: 'OWNER' }).error, undefined);
});

test('an update must actually change something', () => {
  assert.ok(updateStaffSchema.validate({}).error);
  assert.equal(updateStaffSchema.validate({ active: false }).error, undefined);
  assert.equal(updateStaffSchema.validate({ role: 'MANAGER' }).error, undefined);
});
