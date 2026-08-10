const app = require('./app');
const config = require('./config');
const db = require('./connectors/base');
const { connectRedis, closeRedis } = require('./connectors/redis');
const { logger } = require('./connectors/logger');
const { beginShutdown } = require('./lifecycle');

const SHUTDOWN_TIMEOUT_MS = 10000;

/**
 * Builds the shutdown routine.
 *
 * `exit` is injectable so the exit code can be asserted in tests without
 * terminating the test runner.
 */
function createShutdown({ server, exit = process.exit, timeoutMs = SHUTDOWN_TIMEOUT_MS }) {
  return function shutdown(reason, exitCode = 0) {
    if (!beginShutdown()) return;

    // The exit code is the only thing an orchestrator reads. A crash that exits
    // 0 looks like an intentional stop: `restart: on-failure` would not restart
    // it, and Kubernetes would not record it as a failure. Signals exit 0
    // because they *are* intentional; everything else exits non-zero.
    const fatal = exitCode !== 0;
    logger[fatal ? 'fatal' : 'info'](
      { event: 'SHUTDOWN_STARTED', reason, exitCode },
      fatal ? 'Fatal error, draining connections before exit' : 'Draining connections'
    );

    // Readiness already reports 503 by this point, so a load balancer can stop
    // routing new requests while in-flight ones finish.
    const force = setTimeout(() => {
      logger.error({ event: 'SHUTDOWN_TIMED_OUT', reason }, 'Graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs).unref();

    server.close(async () => {
      try {
        await Promise.allSettled([db.close(), closeRedis()]);
      } finally {
        clearTimeout(force);
        exit(exitCode);
      }
    });
  };
}

/**
 * An unhandled rejection is treated as fatal, exactly like an uncaught
 * exception.
 *
 * Registering a listener for `unhandledRejection` overrides Node's own default,
 * which since v15 is to throw and terminate. A listener that only logged
 * therefore did not merely fail to act — it actively disabled the runtime's
 * crash behaviour and left the process running on state nobody had reasoned
 * about.
 *
 * That is not a safe trade for this service. A rejection can surface from the
 * middle of a payment: after a row lock is taken but before the transaction
 * resolves, or between applying a payment and storing its idempotency
 * response. Continuing means serving further payments from a process whose
 * in-flight guarantees are already unknown. Draining and letting the
 * orchestrator start a clean process is the safer outcome.
 */
function installProcessHandlers(shutdown) {
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));

  process.on('unhandledRejection', reason => {
    logger.fatal(
      { event: 'UNHANDLED_REJECTION', err: reason instanceof Error ? reason : new Error(String(reason)) },
      'Unhandled rejection'
    );
    shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', err => {
    logger.fatal({ event: 'UNCAUGHT_EXCEPTION', err }, 'Uncaught exception');
    shutdown('uncaughtException', 1);
  });
}

async function start() {
  // Fail fast: a container that cannot reach its dependencies should never
  // report healthy to the orchestrator.
  await db.query('SELECT 1');
  await connectRedis();

  const server = app.listen(config.port, () => {
    logger.info({ event: 'SERVER_STARTED', port: config.port }, 'Splite API listening');
  });

  installProcessHandlers(createShutdown({ server }));

  return server;
}

if (require.main === module) {
  start().catch(err => {
    logger.fatal({ event: 'STARTUP_FAILED', err }, 'Startup failed');
    process.exit(1);
  });
}

module.exports = { start, createShutdown, installProcessHandlers };
