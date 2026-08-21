const db = require('../connectors/base');
const config = require('../config');
const { logger } = require('../connectors/logger');

/**
 * Deleting rows nothing will ever read again.
 *
 * Four tables grow forever and none of them is a record anyone consults after a
 * point: expired idempotency keys, dead refresh sessions, superseded exchange
 * rates and webhook evidence. `idempotency_keys.purgeExpired()` had existed for
 * some time with nothing calling it, which is the same as not having it.
 *
 * Two rules shape every policy below.
 *
 * The first is that retention is set by what still *reads* the row, not by what
 * feels tidy. `webhook_events_processed` is what stops a redelivered event
 * settling a bill twice, so its retention has to outlast provider retry
 * budgets, which run for days. `fx_rates` feeds the fallback that keeps the
 * product open when BCV is unreachable, so it has to outlast a rate outage.
 *
 * The second is that a purge must never be able to empty a table that
 * something depends on being non-empty. `fx_rates` is the dangerous one: the
 * rate fallback and the deviation baseline both read the newest row per
 * currency, and if FX has been disabled or failing for longer than the
 * retention window, an age-based delete would remove every row and leave the
 * fallback with nothing to fall back to. So that one keeps the newest row per
 * currency whatever its age.
 *
 * Deletes run in bounded batches. A single statement removing a year of
 * webhook deliveries holds locks and bloats WAL for as long as it takes; a loop
 * of small deletes lets the table stay usable while it runs.
 */

const BATCH = 5000;
const MAX_BATCHES = 200;

/**
 * Deletes in batches until nothing matches or the batch ceiling is hit.
 *
 * `ctid` rather than the primary key so this works on tables whose key is
 * composite -- webhook_events_processed has no surrogate id.
 */
async function deleteInBatches(table, where, params, { dryRun }) {
  if (dryRun) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params);
    return rows[0].n;
  }

  let removed = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const { rowCount } = await db.query(
      `DELETE FROM ${table}
        WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${where} LIMIT ${BATCH})`,
      params
    );
    removed += rowCount;
    if (rowCount < BATCH) return removed;
  }

  logger.warn(
    { event: 'PURGE_BATCH_CEILING', table, removed },
    'Stopped at the batch ceiling; run again to continue'
  );
  return removed;
}

const days = n => `${n} days`;

const POLICIES = [
  {
    // Already expired by their own column, and the endpoint that reads them
    // treats a missing key as a first attempt.
    name: 'idempotency_keys',
    run: opts => deleteInBatches('idempotency_keys', 'expires_at < NOW()', [], opts)
  },
  {
    // An expired session cannot authenticate anything. Kept a while past expiry
    // so reuse detection still has something to point at when somebody asks why
    // a token was refused.
    name: 'refresh_sessions',
    run: opts => deleteInBatches(
      'refresh_sessions', 'expires_at < NOW() - $1::interval',
      [days(config.purge.refreshSessionDays)], opts
    )
  },
  {
    // A guest session is dead the moment its absolute cap passes, and nothing
    // reads one afterwards -- unlike a refresh session, there is no reuse
    // detection here to point at. Kept a day past expiry all the same, so a
    // question about an evening's sessions can still be answered the morning
    // after.
    name: 'guest_sessions',
    run: opts => deleteInBatches(
      'guest_sessions', "expires_at < NOW() - INTERVAL '1 day'", [], opts
    )
  },
  {
    /**
     * The newest row per currency is never deleted, whatever its age.
     *
     * Both the rate fallback and the deviation baseline read it, and if FX has
     * been disabled or failing for longer than the retention window an
     * age-based delete would empty the table and leave the fallback with
     * nothing -- turning a purge into the outage the fallback exists to
     * prevent.
     */
    name: 'fx_rates',
    run: opts => deleteInBatches(
      'fx_rates',
      `fetched_at < NOW() - $1::interval
         AND id NOT IN (SELECT DISTINCT ON (base, quote) id
                          FROM fx_rates ORDER BY base, quote, value_date DESC, fetched_at DESC)`,
      [days(config.purge.fxRateDays)], opts
    )
  },
  {
    // Evidence of what a provider sent. Read when somebody disputes a payment,
    // which happens within a billing cycle or not at all.
    name: 'webhook_deliveries',
    run: opts => deleteInBatches(
      'webhook_deliveries', 'received_at < NOW() - $1::interval',
      [days(config.purge.webhookDeliveryDays)], opts
    )
  },
  {
    /**
     * The record that stops a redelivered event settling a bill twice.
     *
     * Retention has to outlast provider retry budgets, which run for days, not
     * hours. Deleting one of these early is not merely losing history: it lets
     * a late retry be treated as new. The payment status check would still
     * catch it -- that is the second layer -- but this is the first, and a
     * default measured in months costs nothing at this volume.
     */
    name: 'webhook_events_processed',
    run: opts => deleteInBatches(
      'webhook_events_processed', 'processed_at < NOW() - $1::interval',
      [days(config.purge.webhookEventDays)], opts
    )
  }
];

/**
 * Runs every policy under an advisory lock.
 *
 * The lock is what makes this safe to schedule from more than one place at
 * once -- a Railway cron and somebody running it by hand, or two replicas.
 * Without it the batched deletes interleave and each one's LIMIT scans rows the
 * other has already taken.
 */
async function purgeAll({ dryRun = false } = {}) {
  const lock = await db.query('SELECT pg_try_advisory_lock($1) AS acquired', [config.purge.lockId]);
  if (!lock.rows[0].acquired) {
    logger.info({ event: 'PURGE_ALREADY_RUNNING' }, 'Another purge holds the lock; skipping');
    return { skipped: true, results: {} };
  }

  const results = {};
  try {
    for (const policy of POLICIES) {
      try {
        results[policy.name] = await policy.run({ dryRun });
      } catch (err) {
        // One table failing must not stop the others: a purge that gives up
        // halfway leaves the largest table growing for another cycle.
        logger.error({ event: 'PURGE_FAILED', table: policy.name, err }, 'Purge failed for a table');
        results[policy.name] = { error: err.message };
      }
    }
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [config.purge.lockId]);
  }

  logger.info({ event: 'PURGE_COMPLETED', dryRun, results }, 'Purge completed');
  return { skipped: false, results };
}

module.exports = { purgeAll, POLICIES };
