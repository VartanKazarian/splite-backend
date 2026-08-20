const db = require('../connectors/base');
const config = require('../config');
const { logger } = require('../connectors/logger');

/**
 * Proving the money still adds up.
 *
 * Two counters in this schema are caches of the ledger, kept in the transaction
 * that moves the money: `bills.amount_paid_ves` and, one level down,
 * `bill_split_participants.amount_paid_ves`. Both have a view that returns the
 * rows where the cache and the ledger disagree, and both views should always be
 * empty.
 *
 * They existed and nothing read them. A drift check that nobody runs is the same
 * as not having one -- the discrepancy is then found by an accountant, or by a
 * diner arguing at a till, which is exactly the situation the ledger was built
 * to make impossible.
 *
 * This is a command rather than a timer inside the API process, for the reason
 * the purge gives: the web process is replicated, and N replicas each running
 * the same scan is work multiplied by N to no effect.
 *
 * Findings are split into two kinds, because they need different responses:
 *
 *   drift     an invariant is broken. Nothing self-heals; a person must look.
 *             The CLI exits non-zero so a scheduler raises it.
 *   attention nothing is broken, but work is queued and nobody may be looking --
 *             C2P charges left unresolved. A warning, never a failure.
 */

/** Bills whose cached paid figure disagrees with their payments. */
async function ledgerDrift({ limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT bill_id, restaurant_id, cached_amount_paid, ledger_amount_paid, difference
       FROM payment_ledger_drift
      ORDER BY abs(difference) DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Split shares whose cached paid figure disagrees with the payments citing them. */
async function splitShareDrift({ limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT participant_id, split_id, restaurant_id, cached_amount_paid, ledger_amount_paid, difference
       FROM bill_split_share_drift
      ORDER BY abs(difference) DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * C2P charges nobody has resolved.
 *
 * Not drift: an IN_DOUBT charge is a correct state, and AMBIGUOUS is the system
 * deliberately refusing to guess. Both are money in a state only a person can
 * end, though, so a queue that has stopped being worked is worth surfacing --
 * the diner has been debited and is waiting.
 *
 * PENDING counts too, once it is this old. It is the state a charge is in while
 * the bank is being called, so it is normal for seconds and impossible for
 * hours: a charge still PENDING after the reconcile threshold is one whose
 * outcome we never managed to record, and it is the only one of the three that
 * nothing else would ever show.
 */
async function unresolvedC2P({ olderThanHours = config.reconcile.unresolvedC2PHours } = {}) {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS count, min(created_at) AS oldest
       FROM payments
      WHERE payment_method = 'C2P'
        AND status IN ('IN_DOUBT', 'AMBIGUOUS', 'PENDING')
        AND created_at < NOW() - ($1 || ' hours')::interval
      GROUP BY status`,
    [String(olderThanHours)]
  );
  return rows;
}

/**
 * Declared Pago Movil claims nobody has worked.
 *
 * The counterpart to `unresolvedC2P`, and arguably the more urgent of the two.
 * A C2P charge in doubt is money Splite moved and cannot yet classify; an
 * unconfirmed claim is money a diner says they sent, sitting in a queue that
 * only tells anybody it exists when somebody opens it. The rail that works
 * today is the one with no notification at all, so this is what makes an
 * ignored queue audible without waiting for a screen to be built.
 *
 * Attention, not drift: a pending claim is a correct state. What is not correct
 * is a pending claim from last night.
 */
async function unworkedClaims({ olderThanHours = config.reconcile.unworkedClaimsHours } = {}) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS count, min(created_at) AS oldest
       FROM payments
      WHERE payment_method = 'PAGO_MOVIL'
        AND status = 'PENDING'
        AND created_at < NOW() - ($1 || ' hours')::interval`,
    [String(olderThanHours)]
  );
  // count(*) always returns a row; an empty queue is zero, not an absence.
  return rows[0].count > 0 ? rows[0] : null;
}

/**
 * Runs every check and reports what it found.
 *
 * Never throws for a finding -- a broken invariant is a result, not an error --
 * so the caller decides what a finding means. It does throw if a check itself
 * cannot run, because a reconciler that cannot read the database must not report
 * "no drift".
 */
async function reconcileAll({ limit = 50 } = {}) {
  const [ledger, shares, unresolved, claims] = await Promise.all([
    ledgerDrift({ limit }),
    splitShareDrift({ limit }),
    unresolvedC2P(),
    unworkedClaims()
  ]);

  const driftCount = ledger.length + shares.length;
  const result = {
    ok: driftCount === 0,
    drift: { ledger, splitShares: shares },
    attention: { unresolvedC2P: unresolved, unworkedClaims: claims },
    checkedAt: new Date().toISOString()
  };

  if (driftCount) {
    logger.error(
      { event: 'RECONCILE_DRIFT_FOUND', ledger: ledger.length, splitShares: shares.length },
      'Ledger drift detected: a cached paid figure disagrees with the payments behind it'
    );
  } else {
    logger.info({ event: 'RECONCILE_CLEAN' }, 'Ledger and split shares agree');
  }

  for (const row of unresolved) {
    logger.warn(
      { event: 'RECONCILE_UNRESOLVED_C2P', status: row.status, count: row.count, oldest: row.oldest },
      'C2P charges are waiting on a person'
    );
  }

  if (claims) {
    logger.warn(
      { event: 'RECONCILE_UNWORKED_CLAIMS', count: claims.count, oldest: claims.oldest },
      'Declared payments are sitting unconfirmed; the diners believe they have paid'
    );
  }

  return result;
}

module.exports = { reconcileAll, ledgerDrift, splitShareDrift, unresolvedC2P, unworkedClaims };
