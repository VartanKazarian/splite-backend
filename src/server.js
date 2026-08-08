const app = require('./app');
const config = require('./config');
const db = require('./connectors/base');
const { connectRedis, closeRedis } = require('./connectors/redis');

const SHUTDOWN_TIMEOUT_MS = 10000;

async function start() {
  // Fail fast: a container that cannot reach its dependencies should never
  // report healthy to the orchestrator.
  await db.query('SELECT 1');
  await connectRedis();

  const server = app.listen(config.port, () => {
    console.log(`Splite API listening on :${config.port} (${config.env})`);
  });

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: draining connections`);

    const force = setTimeout(() => {
      console.error('Graceful shutdown timed out, forcing exit');
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
    console.error('[UnhandledRejection]', reason instanceof Error ? reason.message : reason);
  });
  process.on('uncaughtException', err => {
    console.error('[UncaughtException]', err.message, err.stack);
    shutdown('uncaughtException');
  });

  return server;
}

if (require.main === module) {
  start().catch(err => {
    console.error('[Startup]', err.message);
    process.exit(1);
  });
}

module.exports = { start };
