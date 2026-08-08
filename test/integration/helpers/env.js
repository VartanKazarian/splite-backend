/**
 * Gate for tests that need a live Postgres and Redis.
 *
 * The unit suite (`npm test`) stubs the transaction boundary, so it cannot
 * observe row locking, unique-constraint races or CHECK enforcement. These
 * tests talk to real services instead, and run in CI against the workflow's
 * Postgres and Redis service containers.
 *
 * Gating is a synchronous env check rather than a connection probe on purpose:
 * once RUN_INTEGRATION is set, a service that will not connect is a genuine
 * failure and must fail the run, not silently skip it.
 */
const enabled = ['1', 'true', 'yes'].includes(String(process.env.RUN_INTEGRATION || '').toLowerCase());

const skip = enabled
  ? false
  : 'set RUN_INTEGRATION=1 with a live Postgres and Redis to run integration tests';

module.exports = { enabled, skip };
