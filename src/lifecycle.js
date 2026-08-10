/**
 * Process lifecycle state.
 *
 * Lives on its own so the readiness probe can see that a shutdown has started
 * without importing the server, and the server can flip it without importing
 * the app.
 */

let shuttingDown = false;

/**
 * Marks the process as draining. Returns true only for the first caller, so a
 * SIGTERM arriving while an unhandled rejection is already tearing the process
 * down does not start a second shutdown.
 */
function beginShutdown() {
  if (shuttingDown) return false;
  shuttingDown = true;
  return true;
}

function isShuttingDown() {
  return shuttingDown;
}

/** Test seam. */
function __reset() {
  shuttingDown = false;
}

module.exports = { beginShutdown, isShuttingDown, __reset };
