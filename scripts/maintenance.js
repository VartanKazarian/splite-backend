#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * The scheduled maintenance pass: purge, then reconcile.
 *
 *   npm run maintenance
 *
 * One command so a deployment needs one cron entry rather than two, and in this
 * order deliberately -- the purge only ever deletes rows nothing reads, so it
 * cannot create drift, and running the check afterwards means the figures
 * reported are the ones the database is left holding.
 *
 * Each step runs as its own process so one cannot leave the other's connection
 * pool or exit code behind. The pass reports the worst outcome of the two:
 * housekeeping that failed is worth knowing about, but drift is the finding
 * that must not be lost behind it, so its exit code wins.
 */

const STEPS = [
  { name: 'purge', script: 'purge.js' },
  { name: 'reconcile', script: 'reconcile.js' }
];

let worst = 0;

for (const step of STEPS) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(process.execPath, [path.join(__dirname, step.script)], {
    stdio: 'inherit',
    env: process.env
  });

  const code = result.status ?? 1;
  if (result.error) {
    console.error(`${step.name} could not be started: ${result.error.message}`);
  }
  // Reconcile's 1 (drift found) outranks a purge failure: one is money not
  // adding up, the other is disk.
  if (code > worst) worst = code;
}

if (worst !== 0) {
  console.error(`\nMaintenance finished with findings (exit ${worst}).`);
}
process.exit(worst);
