const db = require('../connectors/base');
const config = require('../config');
const { ApiError } = require('../errors');
const billItems = require('./billItems');
const splitEngine = require('./splitEngine');
const { usdReference } = require('./split');
const { logAudit } = require('./audit');
const { logger } = require('../connectors/logger');

/**
 * Persistent bill splits.
 *
 * A split is created *from* the advisory engine, not instead of it: the engine
 * still decides who owes what, and this stores that decision so a group can
 * agree it once and pay against it from several phones. The engine's exactness
 * guarantee (shares sum to the outstanding balance) becomes a database
 * guarantee here (migration 020), so a split that does not add up cannot exist.
 *
 * The plan is frozen at its basis -- the outstanding balance the moment it was
 * agreed. It does not move as the bill is paid, which is what lets a share be
 * paid down independently while bills.amount_paid_ves goes on meaning the same
 * thing it always did: the total actually settled, from any source.
 */

const PARTICIPANT_COLUMNS = `id, ext_ref, name, amount_ves, amount_paid_ves`;

/**
 * Creates and stores a split from a validated split request.
 *
 * The allocation is computed by the same engine the preview endpoint uses, so a
 * persisted split and a preview of the same request are never different
 * numbers. Then the split, its participants and (for ITEMS) its claims are
 * written in one transaction -- the deferred sum constraint checks the shares
 * against the basis at commit, whole.
 */
async function createSplit({ restaurantId, bill, items, request, createdBy }) {
  // Compute first, outside the transaction: an invalid request (shares that do
  // not add up, an unclaimed line, an unknown participant) is the engine's to
  // reject, with the specific error, before anything is written.
  const allocation = splitEngine.preview({ bill, items, request });

  // Map the client's participant label -> the row we are about to create, so an
  // ITEMS claim can be recorded against the persisted participant id.
  const byExtRef = new Map();

  try {
    const created = await db.withTransaction(async client => {
      const splitRow = (await client.query(
        `INSERT INTO bill_splits (restaurant_id, bill_id, mode, basis_ves, created_by_type, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, mode, basis_ves, status, created_at`,
        [restaurantId, bill.id, request.mode, allocation.outstandingVes, createdBy.type, createdBy.id]
      )).rows[0];

      for (const share of allocation.allocations) {
        const participant = (await client.query(
          `INSERT INTO bill_split_participants (restaurant_id, split_id, ext_ref, name, amount_ves)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, ext_ref`,
          [restaurantId, splitRow.id, share.participantId, share.name, share.amountVes]
        )).rows[0];
        byExtRef.set(participant.ext_ref, participant.id);
      }

      // ITEMS: record the whole-line claims, translated from the request's
      // participant labels to the persisted participant ids.
      if (request.mode === 'ITEMS') {
        for (const claim of request.claims ?? []) {
          for (const extRef of claim.participantIds) {
            await client.query(
              `INSERT INTO bill_split_items (restaurant_id, split_id, bill_item_id, participant_id)
               VALUES ($1, $2, $3, $4)`,
              [restaurantId, splitRow.id, claim.itemId, byExtRef.get(extRef)]
            );
          }
        }
      }

      return splitRow.id;
    }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

    await logAudit({
      restaurantId,
      actorId: createdBy.id,
      action: 'BILL_SPLIT_CREATED',
      resourceType: 'bill',
      resourceId: bill.id,
      details: { splitId: created, mode: request.mode, basisVes: allocation.outstandingVes }
    });

    return getSplit({ restaurantId, splitId: created, bill });
  } catch (err) {
    // The partial unique index: a live split already exists on this bill.
    if (err.code === '23505' && String(err.constraint || '').includes('one_active_per_bill')) {
      throw new ApiError(
        'SPLIT_ALREADY_EXISTS',
        'This bill already has an active split; void it before creating another'
      );
    }
    throw err;
  }
}

/** A split with its participants and, for ITEMS, its claims. */
async function getSplit({ restaurantId, splitId, bill = null }) {
  const split = (await db.query(
    `SELECT id, bill_id, mode, basis_ves, status, created_by_type, created_at, updated_at
       FROM bill_splits WHERE id = $1 AND restaurant_id = $2`,
    [splitId, restaurantId]
  )).rows[0];
  if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'Split not found');

  const participants = (await db.query(
    `SELECT ${PARTICIPANT_COLUMNS} FROM bill_split_participants
      WHERE split_id = $1 ORDER BY created_at ASC`,
    [splitId]
  )).rows;

  const claims = split.mode === 'ITEMS'
    ? (await db.query(
      `SELECT bill_item_id, participant_id FROM bill_split_items WHERE split_id = $1`,
      [splitId]
    )).rows
    : [];

  const rate = bill?.fx_rate_ves_per_unit
    ?? (await db.query('SELECT fx_rate_ves_per_unit FROM bills WHERE id = $1 AND restaurant_id = $2',
      [split.bill_id, restaurantId])).rows[0]?.fx_rate_ves_per_unit
    ?? null;

  return { split, participants, claims, fxRate: rate };
}

/** The active split for a bill, or null. */
async function getActiveSplit({ restaurantId, billId, bill = null }) {
  const row = (await db.query(
    `SELECT id FROM bill_splits WHERE restaurant_id = $1 AND bill_id = $2 AND status = 'ACTIVE'`,
    [restaurantId, billId]
  )).rows[0];
  if (!row) return null;
  return getSplit({ restaurantId, splitId: row.id, bill });
}

/**
 * Voids a split.
 *
 * Refused once any share has been paid into: a plan people have started
 * settling against is a record, not a draft, and unmaking it would orphan the
 * payments that cite its shares. Change then is void-what-is-unpaid only by
 * agreeing a fresh split on the remaining balance.
 */
async function voidSplit({ restaurantId, splitId, actor }) {
  const result = await db.withTransaction(async client => {
    const split = (await client.query(
      `SELECT id, status FROM bill_splits WHERE id = $1 AND restaurant_id = $2 FOR UPDATE`,
      [splitId, restaurantId]
    )).rows[0];
    if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'Split not found');
    if (split.status !== 'ACTIVE') {
      throw new ApiError('SPLIT_NOT_ACTIVE', 'That split has already been voided', { status: split.status });
    }

    const { rows } = await client.query(
      `SELECT COALESCE(SUM(amount_paid_ves), 0)::BIGINT AS paid
         FROM bill_split_participants WHERE split_id = $1`,
      [splitId]
    );
    if (BigInt(rows[0].paid) > 0n) {
      throw new ApiError('SPLIT_HAS_PAYMENTS', 'A split with payments against it cannot be voided');
    }

    await client.query(
      `UPDATE bill_splits SET status = 'VOID' WHERE id = $1 AND restaurant_id = $2`,
      [splitId, restaurantId]
    );
    return split.id;
  });

  await logAudit({
    restaurantId,
    actorId: actor?.id ?? null,
    action: 'BILL_SPLIT_VOIDED',
    resourceType: 'bill_split',
    resourceId: result
  });

  return getSplit({ restaurantId, splitId: result });
}

/**
 * Advances a share by a settled amount, on the caller's transaction.
 *
 * The single point every rail's settlement passes through to credit a share --
 * called from src/services/payments.js when a payment carrying a
 * split_participant_id reaches a settled state, in the same transaction that
 * moved the money. The row is locked first so two diners paying one share
 * serialise, and the not-overpaid CHECK is what turns "pay more than your
 * share" into a rejection rather than a silently oversized amount_paid_ves.
 *
 * Returns nothing; throws SPLIT_SHARE_OVERPAID on the ceiling, SPLIT_SHARE_NOT_FOUND
 * if the id does not resolve within the tenant.
 */
async function advanceShare(client, { splitParticipantId, restaurantId, amountVes, billId }) {
  // Locked, and joined to its split so the share cannot be credited unless it
  // belongs to the bill this payment settled and its split is still live.
  // Without the bill check, paying one bill could mark a share of another's
  // split as paid; without the status check, a voided plan could still be
  // settled against.
  const locked = (await client.query(
    `SELECT p.id, p.amount_ves, p.amount_paid_ves, s.bill_id, s.status
       FROM bill_split_participants p
       JOIN bill_splits s ON s.id = p.split_id AND s.restaurant_id = p.restaurant_id
      WHERE p.id = $1 AND p.restaurant_id = $2
      FOR UPDATE OF p`,
    [splitParticipantId, restaurantId]
  )).rows[0];
  if (!locked || (billId != null && locked.bill_id !== billId)) {
    throw new ApiError('SPLIT_SHARE_NOT_FOUND', 'That split participant does not belong to this bill');
  }
  if (locked.status !== 'ACTIVE') {
    throw new ApiError('SPLIT_NOT_ACTIVE', 'That split has been voided', { status: locked.status });
  }

  try {
    await client.query(
      `UPDATE bill_split_participants
          SET amount_paid_ves = amount_paid_ves + $1
        WHERE id = $2 AND restaurant_id = $3`,
      [String(amountVes), splitParticipantId, restaurantId]
    );
  } catch (err) {
    if (err.code === '23514' && String(err.constraint || '').includes('not_overpaid')) {
      const remaining = BigInt(locked.amount_ves) - BigInt(locked.amount_paid_ves);
      throw new ApiError(
        'SPLIT_SHARE_OVERPAID',
        'This payment exceeds what is left on that share',
        { shareRemainingVes: remaining.toString() }
      );
    }
    throw err;
  }
}

module.exports = {
  createSplit, getSplit, getActiveSplit, voidSplit, advanceShare
};
