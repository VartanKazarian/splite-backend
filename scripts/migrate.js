const fs = require('fs');
const path = require('path');
const db = require('../src/connectors/base');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Arbitrary but stable: any concurrent migrate run blocks on the same key.
const ADVISORY_LOCK_ID = 4815162342;

async function run() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();

  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Session-level advisory lock so two deploys cannot apply the same
  // migration concurrently.
  const lockClient = await db.getClient();
  await lockClient.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

  try {
    for (const file of files) {
      const { rows } = await db.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
      if (rows.length) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      // Each migration is atomic: either the whole file and its ledger row
      // land, or neither does.
      await db.withTransaction(async client => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      });
      console.log(`Applied ${file}`);
    }
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    lockClient.release();
  }
}

/**
 * Everything known about a failure, not just its message.
 *
 * Node throws an AggregateError when a host resolves to several addresses and
 * every connection fails -- and an AggregateError's `message` is empty, so
 * printing only that produced a bare "[Migrate]" and told us nothing. The
 * causes live in `.errors`.
 */
function describe(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);
  if (err?.code) parts.push(`code=${err.code}`);
  if (Array.isArray(err?.errors) && err.errors.length) {
    parts.push('causes: ' + err.errors.map(e => `${e.code || e.name || 'error'} ${e.message || ''}`.trim()).join('; '));
  }
  if (!parts.length) parts.push(err?.name || String(err));
  return parts.join(' | ');
}

/**
 * Waits for the database to accept a connection before migrating.
 *
 * A pre-deploy step runs the instant the container starts, and on a managed
 * platform the private network is not always routable that early. Failing on
 * the first refused connection turns a few seconds of startup into a failed
 * deploy, so this retries a bounded number of times and reports each attempt
 * rather than dying silently.
 */
async function waitForDatabase({ attempts = 10, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await db.query('SELECT 1');
      if (attempt > 1) console.log(`Database reachable after ${attempt} attempts`);
      return;
    } catch (err) {
      if (attempt === attempts) throw err;
      console.log(`Waiting for the database (${attempt}/${attempts}): ${describe(err)}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

waitForDatabase()
  .then(run)
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('[Migrate]', describe(err));
    if (err?.stack) console.error(err.stack);
    await db.close().catch(() => {});
    process.exit(1);
  });
