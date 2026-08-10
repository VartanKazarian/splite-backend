const { Pool } = require('pg');
const config = require('../config');
const { logger } = require('./logger');

const shared = {
  max: config.db.poolMax,
  idleTimeoutMillis: config.db.idleTimeoutMs,
  connectionTimeoutMillis: config.db.connectionTimeoutMs,
  // Server-side, so Postgres cancels the statement itself. A client-side
  // `query_timeout` would only make node-pg stop waiting while the backend
  // carried on holding locks and burning CPU.
  statement_timeout: config.db.statementTimeoutMs,
  // Bounds a transaction that has stopped making progress. Without it, a
  // client that stalls between BEGIN and COMMIT holds its row locks until the
  // TCP connection dies, which on a bill under FOR UPDATE blocks every other
  // diner trying to pay it.
  idle_in_transaction_session_timeout: config.db.idleInTransactionTimeoutMs,
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

pool.on('error', err => logger.error({ event: 'POSTGRES_POOL_ERROR', err }, 'Postgres pool error'));

/**
 * Runs fn inside a transaction and always releases the client.
 * Rollback failures are swallowed so they cannot mask the original error.
 *
 * `statementTimeoutMs` raises or lowers the per-statement budget for this
 * transaction only. One universal timeout does not fit: a menu listing that
 * takes five seconds is broken, while a payment queued behind four other
 * diners holding the same bill's row lock is working exactly as designed, and
 * lock waiting counts toward the same budget.
 *
 * SET LOCAL reverts at COMMIT or ROLLBACK, so a raised budget cannot leak onto
 * the next caller to borrow this pooled connection.
 */
async function withTransaction(fn, { statementTimeoutMs } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (Number.isInteger(statementTimeoutMs) && statementTimeoutMs > 0) {
      // set_config rather than `SET LOCAL statement_timeout = $1`: SET does not
      // accept bind parameters, and interpolating into SQL is how injection
      // gets in. The third argument scopes it to the transaction.
      await client.query("SELECT set_config('statement_timeout', $1, true)", [String(statementTimeoutMs)]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (rollbackError) {
      logger.error({ event: 'POSTGRES_ROLLBACK_FAILED', err: rollbackError }, 'Rollback failed');
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
