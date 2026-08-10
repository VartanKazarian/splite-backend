const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const config = require('../../src/config');

/**
 * A timeout that never fires is indistinguishable from no timeout at all, so
 * these run against a real Postgres and actually wait for the cancellation.
 */
describe('database timeouts', { skip }, () => {
  after(async () => { await db.close(); });

  it('cancels a statement that outruns the default budget', async () => {
    // 57014 is query_canceled: Postgres stopped it, rather than the client
    // giving up while the backend kept working.
    await assert.rejects(
      () => db.query(`SELECT pg_sleep(${(config.db.statementTimeoutMs / 1000) + 3})`),
      err => {
        assert.equal(err.code, '57014', 'query_canceled');
        return true;
      }
    );
  });

  it('leaves a statement inside the budget alone', async () => {
    const { rows } = await db.query('SELECT pg_sleep(0.05), 1 AS ok');
    assert.equal(rows[0].ok, 1);
  });

  it('applies the raised budget inside a transaction', async () => {
    const applied = await db.withTransaction(
      async client => (await client.query('SHOW statement_timeout')).rows[0].statement_timeout,
      { statementTimeoutMs: 15000 }
    );
    assert.equal(applied, '15s');
  });

  it('does not leak a raised budget onto the next user of the connection', async () => {
    await db.withTransaction(async () => {}, { statementTimeoutMs: 30000 });

    // SET LOCAL reverts at COMMIT. Without that, a pooled connection would
    // carry one payment's enlarged budget into every later query on it.
    const { rows } = await db.query('SHOW statement_timeout');
    assert.equal(rows[0].statement_timeout, `${config.db.statementTimeoutMs}ms`);
  });

  it('still cancels inside a transaction, just later', async () => {
    await assert.rejects(
      () => db.withTransaction(
        async client => client.query('SELECT pg_sleep(3)'),
        { statementTimeoutMs: 300 }
      ),
      err => {
        assert.equal(err.code, '57014');
        return true;
      }
    );
  });

  it('bounds a transaction that stops making progress', async () => {
    // A stalled transaction holds its row locks. On a bill under FOR UPDATE
    // that blocks every other diner paying it, so the session has to be
    // reaped rather than waiting for the TCP connection to die.
    const { rows } = await db.query('SHOW idle_in_transaction_session_timeout');
    assert.equal(rows[0].idle_in_transaction_session_timeout, `${config.db.idleInTransactionTimeoutMs}ms`);
  });
});
