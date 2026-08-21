const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const staff = require('../../src/services/staff');
const { hashPassword, changeOwnPassword } = require('../../src/services/auth');
const { ApiError } = require('../../src/errors');

/**
 * Staff administration against a real Postgres.
 *
 * The rank rule is a pure function and is tested as one in the unit suite. What
 * only a database can show is the half that depends on other rows: that the
 * last owner cannot be removed under concurrency, that a deactivation actually
 * ends the person's refresh sessions, and that the unique index is what reports
 * a duplicate address.
 */
describe('staff administration', { skip }, () => {
  let restaurant;
  let owner;
  let seq = 0;

  const PASSWORD = 'a-long-enough-password';

  const makeUser = async (role, { active = true } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role, active`,
      [restaurant.id, `u${++seq}@example.com`, await hashPassword(PASSWORD), role, active]
    );
    return rows[0];
  };

  const actorFor = user => ({ id: user.id, role: user.role });

  const rejects = async (fn, code) => {
    await assert.rejects(fn, err => {
      assert.ok(err instanceof ApiError, `expected an ApiError, got ${err}`);
      assert.equal(err.code, code);
      return true;
    });
  };

  before(async () => { restaurant = await fixtures.createRestaurant({ name: 'Staff Tenant' }); });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM refresh_sessions WHERE user_id IN (SELECT id FROM users WHERE restaurant_id = $1)', [restaurant.id]);
    await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    owner = await makeUser('OWNER');
  });

  it('creates somebody and never returns a password hash', async () => {
    const created = await staff.createStaff({
      restaurantId: restaurant.id, actor: actorFor(owner),
      email: 'cashier@example.com', password: PASSWORD, role: 'CASHIER'
    });
    assert.equal(created.role, 'CASHIER');
    assert.equal(created.active, true);
    assert.equal('password_hash' in created, false, 'the column is never selected');
  });

  it('reports a duplicate address as a conflict, not a 500', async () => {
    // The unique index is on (restaurant_id, lower(email)), so this is a
    // collision inside one restaurant. The same address elsewhere is a
    // different person as far as this system is concerned.
    const args = {
      restaurantId: restaurant.id, actor: actorFor(owner),
      email: 'twice@example.com', password: PASSWORD, role: 'WAITER'
    };
    await staff.createStaff(args);
    await rejects(() => staff.createStaff(args), 'STAFF_EMAIL_TAKEN');
  });

  it('will not let a manager grant a role at or above their own', async () => {
    // Without this, "may manage staff" silently means "may become an owner".
    const manager = await makeUser('MANAGER');
    for (const role of ['OWNER', 'MANAGER']) {
      await rejects(() => staff.createStaff({
        restaurantId: restaurant.id, actor: actorFor(manager),
        email: `up${role}@example.com`, password: PASSWORD, role
      }), 'STAFF_ROLE_TOO_HIGH');
    }
    const waiter = await staff.createStaff({
      restaurantId: restaurant.id, actor: actorFor(manager),
      email: 'ok@example.com', password: PASSWORD, role: 'WAITER'
    });
    assert.equal(waiter.role, 'WAITER');
  });

  it('will not let a manager touch a peer or an owner', async () => {
    const manager = await makeUser('MANAGER');
    const peer = await makeUser('MANAGER');
    await rejects(() => staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(manager), userId: peer.id, active: false
    }), 'STAFF_OUTRANKED');
    await rejects(() => staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(manager), userId: owner.id, active: false
    }), 'STAFF_OUTRANKED');
  });

  it('refuses to let anybody change their own role or standing', async () => {
    // The rule that stops an owner demoting themselves out of the only account
    // that could undo it.
    await rejects(() => staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(owner), userId: owner.id, role: 'WAITER'
    }), 'STAFF_SELF_FORBIDDEN');
    await rejects(() => staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(owner), userId: owner.id, active: false
    }), 'STAFF_SELF_FORBIDDEN');
  });

  it('lets one of two owners remove the other, and no further', async () => {
    // Worth stating what the rules already guarantee here, because it is not
    // obvious: once a restaurant is down to one active owner, *nothing* can
    // remove them serially. Only an owner may act on an owner, the only owner
    // left is themselves, and the self rule refuses that. So the last-owner
    // check below is not the serial guard -- rank and self are. It is there for
    // the race in the next test, where both of the last two act at once and
    // each would otherwise see the other and proceed.
    const second = await makeUser('OWNER');

    await staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(owner), userId: second.id, role: 'MANAGER'
    });

    const owners = await db.query(
      "SELECT count(*)::int AS n FROM users WHERE restaurant_id = $1 AND role = 'OWNER' AND active = true",
      [restaurant.id]
    );
    assert.equal(owners.rows[0].n, 1);

    // And the survivor cannot be reached: not by themselves, and not by the
    // manager they just demoted.
    await rejects(() => staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(owner), userId: owner.id, role: 'CASHIER'
    }), 'STAFF_SELF_FORBIDDEN');
    await rejects(() => staff.updateStaff({
      restaurantId: restaurant.id, actor: { id: second.id, role: 'MANAGER' }, userId: owner.id, active: false
    }), 'STAFF_OUTRANKED');
  });

  it('cannot remove the last owner even when two requests race', async () => {
    // Both see the other and would each conclude one remains. The count is
    // taken inside the transaction with the row locked, so the second waits for
    // the first and then finds nobody left.
    const second = await makeUser('OWNER');
    const [a, b] = await Promise.allSettled([
      staff.updateStaff({
        restaurantId: restaurant.id, actor: actorFor(second), userId: owner.id, active: false
      }),
      staff.updateStaff({
        restaurantId: restaurant.id, actor: actorFor(owner), userId: second.id, active: false
      })
    ]);

    const outcomes = [a, b].map(r => r.status);
    assert.ok(outcomes.includes('rejected'), 'one of the two must lose');
    const remaining = await db.query(
      "SELECT count(*)::int AS n FROM users WHERE restaurant_id = $1 AND role = 'OWNER' AND active = true",
      [restaurant.id]
    );
    assert.equal(remaining.rows[0].n, 1, 'the restaurant still has an owner');
  });

  it('ends every refresh session when somebody is deactivated', async () => {
    // A removal that leaves the refresh tokens alive has not removed anybody.
    const cashier = await makeUser('CASHIER');
    for (let i = 0; i < 2; i++) {
      await db.query(
        `INSERT INTO refresh_sessions (id, user_id, restaurant_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
        [crypto.randomUUID(), cashier.id, restaurant.id, crypto.randomBytes(32).toString('hex')]
      );
    }

    const { sessionsRevoked } = await staff.updateStaff({
      restaurantId: restaurant.id, actor: actorFor(owner), userId: cashier.id, active: false
    });
    assert.equal(sessionsRevoked, 2);

    const live = await db.query(
      'SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [cashier.id]
    );
    assert.equal(live.rows[0].n, 0);
  });

  it('a password reset ends their sessions too', async () => {
    const cashier = await makeUser('CASHIER');
    await db.query(
      `INSERT INTO refresh_sessions (id, user_id, restaurant_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
      [crypto.randomUUID(), cashier.id, restaurant.id, crypto.randomBytes(32).toString('hex')]
    );

    const hashBefore = await db.query('SELECT password_hash FROM users WHERE id = $1', [cashier.id]);
    const { sessionsRevoked } = await staff.resetStaffPassword({
      restaurantId: restaurant.id, actor: actorFor(owner), userId: cashier.id, password: 'a-different-long-password'
    });
    const hashAfter = await db.query('SELECT password_hash FROM users WHERE id = $1', [cashier.id]);

    assert.equal(sessionsRevoked, 1, 'a reset that leaves the old sessions running locks nobody out');
    assert.notEqual(hashBefore.rows[0].password_hash, hashAfter.rows[0].password_hash);
  });

  it('does not find another restaurant\'s staff', async () => {
    const other = await fixtures.createRestaurant({ name: 'Other Staff Tenant' });
    try {
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, 'theirs@example.com', $2, 'CASHIER') RETURNING id`,
        [other.id, await hashPassword(PASSWORD)]
      );
      await rejects(() => staff.updateStaff({
        restaurantId: restaurant.id, actor: actorFor(owner), userId: rows[0].id, active: false
      }), 'STAFF_NOT_FOUND');

      const mine = await staff.listStaff({ restaurantId: restaurant.id });
      assert.equal(mine.some(u => u.email === 'theirs@example.com'), false);
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('lets somebody change their own password, and signs their other devices out', async () => {
    // The gap the administrator reset created: without this, the only way to
    // change a password you already know is to ask somebody senior to set one
    // and tell it to you, which puts it through a second person.
    const cashier = await makeUser('CASHIER');
    for (let i = 0; i < 2; i++) {
      await db.query(
        `INSERT INTO refresh_sessions (id, user_id, restaurant_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')`,
        [crypto.randomUUID(), cashier.id, restaurant.id, crypto.randomBytes(32).toString('hex')]
      );
    }

    const result = await changeOwnPassword(cashier.id, PASSWORD, 'a-brand-new-long-password');

    assert.equal(result.sessionsRevoked, 2, 'the other devices are signed out');
    assert.ok(result.accessToken, 'and this one is not: a fresh session comes back');
    assert.ok(result.refreshToken);

    // The returned session is not one of the ones just killed.
    const live = await db.query(
      'SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NULL',
      [cashier.id]
    );
    assert.equal(live.rows[0].n, 1);
  });

  it('refuses a password change without the current password', async () => {
    // The whole guard. An access token in somebody else's hands must not be
    // enough to take the account permanently.
    const cashier = await makeUser('CASHIER');
    await rejects(
      () => changeOwnPassword(cashier.id, 'not-the-current-one', 'a-brand-new-long-password'),
      'INVALID_CREDENTIALS'
    );

    // And the password is unchanged, so the real owner still gets in.
    const stillTheirs = await changeOwnPassword(cashier.id, PASSWORD, 'a-brand-new-long-password');
    assert.ok(stillTheirs.accessToken);
  });

  it('refuses a change that changes nothing', async () => {
    // Somebody doing this has a reason -- usually that the current one is known
    // to somebody else. Quietly succeeding without changing it is the worst
    // possible answer.
    const cashier = await makeUser('CASHIER');
    await rejects(() => changeOwnPassword(cashier.id, PASSWORD, PASSWORD), 'PASSWORD_UNCHANGED');
  });

  it('lists the deactivated too, and last', async () => {
    // They are exactly who somebody is looking for in order to reinstate.
    const gone = await makeUser('WAITER', { active: false });
    const rows = await staff.listStaff({ restaurantId: restaurant.id });
    assert.ok(rows.some(u => u.id === gone.id), 'a deactivated account is still listed');
    assert.equal(rows[rows.length - 1].id, gone.id, 'and sorts after the active ones');
  });
});
