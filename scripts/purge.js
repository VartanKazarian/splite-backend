#!/usr/bin/env node

const db = require('../src/connectors/base');
const config = require('../src/config');
const { purgeAll } = require('../src/services/purge');

/**
 * Deletes rows nothing will read again.
 *
 *   npm run purge -- --dry-run     count what would go, delete nothing
 *   npm run purge                  delete it
 *
 * A command rather than a timer inside the API process, for the same reason the
 * reconciler would be: the web process is replicated, and N replicas each
 * waking up to delete the same rows is work multiplied by N to no effect. The
 * advisory lock makes that safe rather than fast, which is not the same thing.
 *
 * Schedule it from Railway's cron, daily and off-peak. Nothing here is urgent:
 * a purge that does not run for a week deletes a week more the next time.
 */

async function run() {
  const dryRun = process.argv.includes('--dry-run');

  const { skipped, results } = await purgeAll({ dryRun });
  if (skipped) {
    console.log('Another purge is already running.');
    return;
  }

  const label = dryRun ? 'would delete' : 'deleted';
  let total = 0;
  for (const [table, result] of Object.entries(results)) {
    if (result && typeof result === 'object' && result.error) {
      console.error(`${table.padEnd(28)} FAILED: ${result.error}`);
      process.exitCode = 1;
      continue;
    }
    total += result;
    console.log(`${table.padEnd(28)} ${label} ${result}`);
  }

  console.log(`\n${label} ${total} row(s) in total.`);
  if (dryRun) console.log('Dry run: nothing was deleted.');
  else {
    console.log(
      '\nRetention, in days: ' +
      `refresh_sessions ${config.purge.refreshSessionDays}, ` +
      `fx_rates ${config.purge.fxRateDays}, ` +
      `webhook_deliveries ${config.purge.webhookDeliveryDays}, ` +
      `webhook_events_processed ${config.purge.webhookEventDays}.`
    );
  }
}

run()
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
