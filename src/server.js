const app = require('./app');
const config = require('./config');
const db = require('./connectors/base');
const { connectRedis, closeRedis } = require('./connectors/redis');
const { logger } = require('./connectors/logger');

const SHUTDOWN_TIMEOUT_MS = 10000;

async function start() {
  // Fail fast: a container that cannot reach its dependencies should never
  // report healthy to the orchestrator.
  await db.query('SELECT 1');
  await connectRedis();

  const server = app.listen(config.port, () => {
    logger.info({ event: 'SERVER_STARTED', port: config.port }, 'Splite API listening');
  });

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ event: 'SHUTDOWN_STARTED', signal }, 'Draining connections');

    const force = setTimeout(() => {
      logger.error({ event: 'SHUTDOWN_TIMED_OUT' }, 'Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();

    server.close(async () => {
      try {
        await Promise.allSettled([db.close(), closeRedis()]);
      } finally {
        clearTimeout(force);
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', reason => {
    logger.error({ event: 'UNHANDLED_REJECTION', err: reason instanceof Error ? reason : new Error(String(reason)) }, 'Unhandled rejection');
  });
  process.on('uncaughtException', err => {
    logger.fatal({ event: 'UNCAUGHT_EXCEPTION', err }, 'Uncaught exception');
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) {
  start().catch(err => {
    logger.fatal({ event: 'STARTUP_FAILED', err }, 'Startup failed');
    process.exit(1);
  });
}

module.exports = { start };
