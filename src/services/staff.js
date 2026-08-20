const db = require('../connectors/base');
const { ApiError } = require('../errors');
const { hashPassword, revokeAllSessionsForUser } = require('./auth');
const { logAudit } = require('./audit');

/**
 * The people who work at a restaurant, and what they may do.
 *
 * This existed only as SQL until now. A restaurant could be created with an
 * owner and never gain a second account, and firing a cashier meant somebody
 * with database access running an UPDATE -- on a system where CASHIER and above
 * decide that money arrived. That is not an access-control model, it is an
 * access-control model plus a promise.
 *
 * Three rules run through everything below, and they are here rather than in
 * the router because a rule enforced at one of four call sites is enforced at
 * none of them.
 *
 *   1. Rank. An OWNER may act on anybody but themselves. Anyone else may act
 *      only on a strictly lower rank, and may only grant a strictly lower rank
 *      -- so a manager cannot promote a waiter to manager, and cannot touch a
 *      peer. Without the second half, "may manage staff" silently means "may
 *      become an owner".
 *
 *   2. Never yourself. Not role, not active. It is the rule that stops an owner
 *      demoting themselves out of the only account that could undo it, and it
 *      costs nothing: another owner can still remove you.
 *
 *   3. The last active owner stays. Checked under lock rather than read first,
 *      because two concurrent requests each deactivating a different one of the
 *      last two owners would each see one remaining and both succeed.
 */

const RANK = { OWNER: 3, MANAGER: 2, CASHIER: 1, WAITER: 1 };

const STAFF_COLUMNS = 'id, restaurant_id, email, role, active, created_at, updated_at';

/**
 * May `actor` act on a user of role `targetRole`?
 *
 * Separate from the self-check because they answer different questions and fail
 * with different messages: one is about standing, the other about which account
 * you happen to be signed in as.
 */
function outranks(actorRole, targetRole) {
  if (actorRole === 'OWNER') return true;
  return (RANK[actorRole] ?? 0) > (RANK[targetRole] ?? 0);
}

function assertMayAssign(actorRole, role) {
  // An owner may appoint anyone, including another owner. Everyone else is
  // bounded by their own rank, which is what keeps "manages staff" from
  // becoming "grants themselves anything".
  if (actorRole === 'OWNER') return;
  if (!((RANK[actorRole] ?? 0) > (RANK[role] ?? 0))) {
    throw new ApiError('STAFF_ROLE_TOO_HIGH', 'You cannot grant a role at or above your own', {
      actorRole, role
    });
  }
}

/** Everyone at this restaurant, including the deactivated. */
async function listStaff({ restaurantId }) {
  const { rows } = await db.query(
    // Deactivated accounts are listed too, and last. They are the ones somebody
    // needs to find in order to reinstate, and hiding them makes a reactivation
    // look like a second account with the same address -- which the unique
    // index then refuses, confusingly.
    `SELECT ${STAFF_COLUMNS} FROM users
      WHERE restaurant_id = $1
      ORDER BY active DESC, role, lower(email)`,
    [restaurantId]
  );
  return rows;
}

async function createStaff({ restaurantId, actor, email, password, role, meta = {} }) {
  assertMayAssign(actor.role, role);

  const passwordHash = await hashPassword(password);

  let created;
  try {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${STAFF_COLUMNS}`,
      [restaurantId, email, passwordHash, role]
    );
    created = rows[0];
  } catch (err) {
    // The unique index is on (restaurant_id, lower(email)), so this is only
    // ever a collision inside this restaurant -- the same address at another
    // restaurant is a different person as far as this system is concerned.
    if (err.code === '23505') {
      throw new ApiError('STAFF_EMAIL_TAKEN', 'Somebody here already uses that address', { email });
    }
    throw err;
  }

  await logAudit({
    ...meta,
    restaurantId,
    actorId: actor.id,
    action: 'STAFF_CREATED',
    resourceType: 'user',
    resourceId: created.id,
    details: { role, email }
  });

  return created;
}

/**
 * Reads the target under lock and applies the three rules to it.
 *
 * Returns the locked row. Every write below goes through this, so a rule cannot
 * be enforced on one path and forgotten on another.
 */
async function lockTarget(client, { restaurantId, actor, userId }) {
  const { rows } = await client.query(
    `SELECT ${STAFF_COLUMNS} FROM users
      WHERE id = $1 AND restaurant_id = $2
      FOR UPDATE`,
    [userId, restaurantId]
  );
  const target = rows[0];
  if (!target) throw new ApiError('STAFF_NOT_FOUND', 'No such person at this restaurant');

  if (target.id === actor.id) {
    throw new ApiError('STAFF_SELF_FORBIDDEN', 'You cannot change your own role or standing', {
      hint: 'Another owner can do this for you'
    });
  }
  if (!outranks(actor.role, target.role)) {
    throw new ApiError('STAFF_OUTRANKED', 'That person is at or above your own role', {
      actorRole: actor.role, targetRole: target.role
    });
  }
  return target;
}

/**
 * Refuses a change that would leave the restaurant with no active owner.
 *
 * Note what this is *not* protecting against. Serially it is unreachable: once
 * a restaurant is down to one active owner, only an owner may act on an owner,
 * the only one left is themselves, and rule 2 refuses that. Rank and self are
 * the serial guard.
 *
 * This is for the race -- both of the last two owners removing each other at
 * the same instant, where each would read the other as remaining and proceed.
 * Counted inside the caller's transaction with the target row already locked,
 * so the second waits for the first and then finds nobody left.
 */
async function assertOwnerRemains(client, { restaurantId, excludingUserId }) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS remaining FROM users
      WHERE restaurant_id = $1 AND role = 'OWNER' AND active = true AND id <> $2`,
    [restaurantId, excludingUserId]
  );
  if (rows[0].remaining === 0) {
    throw new ApiError('STAFF_LAST_OWNER', 'A restaurant must keep one active owner', {
      hint: 'Appoint another owner first'
    });
  }
}

/**
 * Changes a role, a standing, or both.
 *
 * Deactivating revokes every refresh session the person holds, so they cannot
 * mint a new access token. The access token they already hold keeps working
 * until it expires -- at most JWT_ACCESS_TTL, fifteen minutes by default. That
 * is stated rather than hidden: it is the honest cost of stateless tokens, and
 * somebody removing a person after an argument needs to know the door is not
 * shut this second.
 */
async function updateStaff({ restaurantId, actor, userId, role, active, meta = {} }) {
  if (role !== undefined) assertMayAssign(actor.role, role);

  const { updated, previousRole } = await db.withTransaction(async client => {
    const target = await lockTarget(client, { restaurantId, actor, userId });

    const leavingOwner = target.role === 'OWNER'
      && ((role !== undefined && role !== 'OWNER') || active === false);
    if (leavingOwner) await assertOwnerRemains(client, { restaurantId, excludingUserId: target.id });

    const { rows } = await client.query(
      `UPDATE users
          SET role = COALESCE($3, role),
              active = COALESCE($4, active)
        WHERE id = $1 AND restaurant_id = $2
        RETURNING ${STAFF_COLUMNS}`,
      [userId, restaurantId, role ?? null, active ?? null]
    );

    return { updated: rows[0], previousRole: target.role };
  });

  // After the commit, not inside it. The transaction holds `users`; revoking
  // touches `refresh_sessions`, and a failure here must not roll back a removal
  // that has already been decided -- the sessions expire on their own either
  // way. Reactivation is left alone: nothing needs revoking, and the person has
  // no live session to lose.
  const standingChanged = active === false || (role !== undefined && role !== previousRole);
  const revoked = standingChanged ? await revokeAllSessionsForUser(userId) : 0;

  await logAudit({
    ...meta,
    restaurantId,
    actorId: actor.id,
    action: active === false ? 'STAFF_DEACTIVATED' : 'STAFF_UPDATED',
    resourceType: 'user',
    resourceId: userId,
    details: { role: role ?? null, active: active ?? null, sessionsRevoked: revoked }
  });

  return { user: updated, sessionsRevoked: revoked };
}

/**
 * Sets somebody else's password.
 *
 * There is no self-service change yet, so this is also how a forgotten password
 * is recovered: an owner or manager sets a new one and tells the person. It
 * revokes their sessions, which is the point -- a password reset that leaves
 * the old sessions running has not locked anybody out.
 */
async function resetStaffPassword({ restaurantId, actor, userId, password, meta = {} }) {
  const passwordHash = await hashPassword(password);

  await db.withTransaction(async client => {
    await lockTarget(client, { restaurantId, actor, userId });
    await client.query(
      'UPDATE users SET password_hash = $3 WHERE id = $1 AND restaurant_id = $2',
      [userId, restaurantId, passwordHash]
    );
  });

  const revoked = await revokeAllSessionsForUser(userId);

  await logAudit({
    ...meta,
    restaurantId,
    actorId: actor.id,
    action: 'STAFF_PASSWORD_RESET',
    resourceType: 'user',
    resourceId: userId,
    details: { sessionsRevoked: revoked }
  });

  return { sessionsRevoked: revoked };
}

module.exports = { RANK, outranks, listStaff, createStaff, updateStaff, resetStaffPassword };
