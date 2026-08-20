#!/usr/bin/env node

const db = require('../src/connectors/base');
const { reconcileAll } = require('../src/services/reconcile');

/**
 * Checks that the money still adds up.
 *
 *   npm run reconcile
 *
 * Exits non-zero when an invariant is broken, so whatever runs it -- a Railway
 * cron, a CI job, somebody at a terminal -- raises it rather than logging into
 * the void. Nothing here repairs anything: drift means a write path is wrong,
 * and quietly correcting the symptom would remove the only evidence of it.
 *
 * A command rather than a timer inside the API, for the reason the purge gives:
 * the web process is replicated and N replicas each scanning is work multiplied
 * by N to no effect.
 */

function table(rows, columns) {
  for (const row of rows) {
    console.error('  ' + columns.map(c => `${c}=${row[c]}`).join('  '));
  }
}

async function run() {
  const result = await reconcileAll();

  if (result.drift.ledger.length) {
    console.error(`\nBILL LEDGER DRIFT — ${result.drift.ledger.length} bill(s):`);
    console.error('  bills.amount_paid_ves disagrees with the payments behind it.');
    table(result.drift.ledger, ['bill_id', 'cached_amount_paid', 'ledger_amount_paid', 'difference']);
  }

  if (result.drift.splitShares.length) {
    console.error(`\nSPLIT SHARE DRIFT — ${result.drift.splitShares.length} share(s):`);
    console.error('  A share\'s cached amount_paid_ves disagrees with the payments citing it.');
    table(result.drift.splitShares, ['participant_id', 'cached_amount_paid', 'ledger_amount_paid', 'difference']);
  }

  for (const row of result.attention.unresolvedC2P) {
    console.log(
      `\nAttention: ${row.count} C2P charge(s) ${row.status}, oldest ${new Date(row.oldest).toISOString()}.` +
      '\n  Not drift — these are waiting on a person. Work the queue at GET /api/v1/payments/c2p/unresolved.'
    );
  }

  if (result.attention.unworkedClaims) {
    const { count, oldest } = result.attention.unworkedClaims;
    console.log(
      `\nAttention: ${count} declared payment(s) still unconfirmed, oldest ${new Date(oldest).toISOString()}.` +
      '\n  Not drift — but the diners who declared them believe they have paid.' +
      '\n  Work the queue at GET /api/v1/payments/claims.'
    );
  }

  if (result.ok) {
    console.log('\nLedger and split shares agree. No drift.');
    return;
  }

  console.error('\nDrift is a bug in a write path, not something to repair by hand:');
  console.error('  fix the cause, then correct the rows deliberately and record why.');
  process.exitCode = 1;
}

run()
  .catch(err => {
    // A reconciler that cannot run must never look like a clean result.
    console.error(`Reconcile failed to run: ${err.message}`);
    process.exitCode = 2;
  })
  .finally(() => db.close());
