const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../src/lifecycle');
const { createShutdown } = require('../src/server');
const db = require('../src/connectors/base');
const redisConnector = require('../src/connectors/redis');

const realDbClose = db.close;
const realRedisClose = redisConnector.closeRedis;

beforeEach(() => {
  lifecycle.__reset();
  // The shutdown routine closes both; neither is reachable in the unit suite.
  db.close = async () => {};
  redisConnector.closeRedis = async () => {};
});

afterEach(() => {
  lifecycle.__reset();
  db.close = realDbClose;
  redisConnector.closeRedis = realRedisClose;
});

/** A server whose close() runs its callback on the next tick. */
function fakeServer() {
  const state = { closed: false };
  return {
    state,
    close(cb) {
      state.closed = true;
      setImmediate(cb);
    }
  };
}

const runShutdown = (reason, exitCode) => new Promise(resolve => {
  const server = fakeServer();
  const shutdown = createShutdown({ server, exit: code => resolve({ code, server }) });
  shutdown(reason, exitCode);
});

test('a signal exits 0, because stopping was intentional', async () => {
  const { code, server } = await runShutdown('SIGTERM', 0);
  assert.equal(code, 0);
  assert.equal(server.state.closed, true, 'connections were drained first');
});

test('an unhandled rejection exits non-zero', async () => {
  // The exit code is the only thing an orchestrator reads. Exiting 0 after a
  // crash reads as an intentional stop, so `restart: on-failure` would leave
  // the service down.
  const { code } = await runShutdown('unhandledRejection', 1);
  assert.equal(code, 1);
});

test('an uncaught exception exits non-zero', async () => {
  const { code } = await runShutdown('uncaughtException', 1);
  assert.equal(code, 1);
});

test('a fatal shutdown still drains rather than exiting immediately', async () => {
  // In-flight payments get the chance to finish; severing them mid-transaction
  // is what the graceful path exists to avoid.
  const { server } = await runShutdown('unhandledRejection', 1);
  assert.equal(server.state.closed, true);
});

test('a second shutdown is ignored while one is already running', async () => {
  const exits = [];
  const server = fakeServer();
  const shutdown = createShutdown({ server, exit: code => exits.push(code) });

  shutdown('unhandledRejection', 1);
  shutdown('SIGTERM', 0);
  await new Promise(r => setImmediate(r));

  assert.deepEqual(exits, [1], 'the first reason wins; a later signal cannot mask a crash as a clean exit');
});

test('readiness reports draining as soon as a shutdown begins', async () => {
  assert.equal(lifecycle.isShuttingDown(), false);

  const server = fakeServer();
  createShutdown({ server, exit: () => {} })('SIGTERM', 0);

  assert.equal(lifecycle.isShuttingDown(), true, 'the flag flips before close() completes');
});

test('a hung close is forced out with a failure code', async () => {
  const code = await new Promise(resolve => {
    // A server that never invokes its callback.
    const server = { close() {} };

    // The force timer is unref'd on purpose: if nothing else is keeping the
    // event loop alive there is nothing left to wait for and the process exits
    // on its own. It only needs to fire when something *is* still holding the
    // loop open — a lingering keep-alive connection in production. This timer
    // stands in for that, otherwise the timer under test would never run.
    const holdLoopOpen = setInterval(() => {}, 5);

    createShutdown({
      server,
      timeoutMs: 20,
      exit: code => { clearInterval(holdLoopOpen); resolve(code); }
    })('SIGTERM', 0);
  });

  // Forced exit is a failure even when the shutdown began cleanly: something
  // refused to let go.
  assert.equal(code, 1);
});
