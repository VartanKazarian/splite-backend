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

run()
  .then(() => db.close())
  .then(() => process.exit(0))
  .catch(async err => {
    console.error('[Migrate]', err.message);
    await db.close().catch(() => {});
    process.exit(1);
  });
