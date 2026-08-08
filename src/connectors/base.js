const { Pool } = require('pg');
const config = require('../config');

const shared = {
  max: config.db.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // rejectUnauthorized is intentionally configurable: managed providers
  // (Railway, Heroku) terminate TLS with certificates that are not in the
  // default CA bundle. Set DB_SSL_REJECT_UNAUTHORIZED=true once you pin a CA.
  ssl: config.db.ssl
    ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' }
    : undefined
};

const pool = new Pool(
  config.db.connectionString
    ? { connectionString: config.db.connectionString, ...shared }
    : {
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        ...shared
      }
);

pool.on('error', err => console.error('[Postgres pool]', err.message));

/**
 * Runs fn inside a transaction and always releases the client.
 * Rollback failures are swallowed so they cannot mask the original error.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      console.error('[Postgres rollback]', rollbackError.message);
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  withTransaction,
  close: () => pool.end()
};
