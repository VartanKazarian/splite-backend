const { AsyncLocalStorage } = require('node:async_hooks');
const pino = require('pino');
const config = require('../config');

/**
 * Structured logging.
 *
 * Two problems with console.* that this exists to solve:
 *
 *  1. A line like `console.error('[Payment] failed', err.message)` cannot be
 *     filtered, aggregated or alerted on. Every log is now an object with an
 *     `event` field, so "how many payments failed for this restaurant today"
 *     is a query rather than a grep.
 *  2. Nothing tied a log line to the request that produced it. Correlation ids
 *     existed but only reached Morgan's access log, so an error deep in a
 *     service could not be traced back to a caller or a tenant.
 *
 * Request context is carried in AsyncLocalStorage and merged into every line by
 * pino's `mixin`, so a service logs without being handed a request object and
 * without threading requestId through call signatures it has no other use for.
 */

const storage = new AsyncLocalStorage();

/**
 * The active context, as a fresh object on every call.
 *
 * This is the logger's `mixin`. The copy is the whole point: pino merges the
 * caller's fields into whatever this returns, so handing back the live store
 * let a single log line write its own `event` and error into the request
 * context, and every later line in that request inherited them.
 *
 * Exported so the copying can be tested directly. A test that builds its own
 * pino instance proves nothing about this configuration.
 */
function contextSnapshot() {
  return { ...(storage.getStore() ?? {}) };
}

/**
 * Values that must never reach a log, whatever nests them.
 *
 * Redaction is a safety net rather than a licence to log secrets: the aim is
 * that an accidental `logger.info({ req })` cannot leak a bearer token.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-guest-session"]',
  'req.headers["x-pos-api-key"]',
  'req.headers["x-pos-signature"]',
  'req.headers["x-webhook-signature"]',
  'headers.authorization',
  'headers.cookie',
  // Node's raw header array is a flat [name, value, name, value, ...], so it
  // cannot be redacted by key and carries the bearer token verbatim. It is
  // reachable from more places than it looks: a response object exposes the
  // request that produced it, so `res.req.rawHeaders` leaked the Authorization
  // header into the access log even with a custom `res` serializer.
  'rawHeaders',
  'req.rawHeaders',
  'res.req',
  '*.rawHeaders',
  'password',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'guestToken',
  'qrToken',
  'tokenHash',
  'secret',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.guestToken',
  // The diner's single-use C2P clave, and the identity documents that travel
  // beside it. The Mercantil adapter has its own redact() over the one call
  // site that deliberately logs a request body, and this is the net under it:
  // the clave is the most sensitive transient value in the system, and a
  // cedula is somebody's identity document rather than a payment detail.
  //
  // Spelled at each depth a body actually reaches a log at. pino's `*` matches
  // one level, so '*.clave' covers `body.clave` and not `req.body.clave`.
  'clave',
  '*.clave',
  'body.clave',
  'req.body.clave',
  'idNumber',
  '*.idNumber',
  'body.idNumber',
  'req.body.idNumber',
  'idOrigin',
  '*.idOrigin',
  'body.idOrigin',
  'req.body.idOrigin',
  // TOTP material. The secret is sealed at rest; these are the shapes it and
  // the recovery codes pass through in memory.
  'mfaSecret',
  'mfa_secret',
  '*.mfaSecret',
  '*.mfa_secret',
  'recoveryCodes',
  '*.recoveryCodes',
  'otpauthUri',
  '*.otpauthUri'
];

/**
 * Counts what it logs, at warn and above.
 *
 * Every failure this service knows how to have already passes through here
 * carrying an `event` field. Counting at this one point means a new failure
 * mode becomes a metric the moment somebody logs it, rather than the moment
 * somebody remembers to instrument it -- which is how AUDIT_WRITE_FAILED came
 * to be swallowed with nothing watching.
 *
 * Required lazily. `metrics` reaches for the database for its gauges, and this
 * module is imported by config-time code that must not open a pool.
 *
 * Never allowed to break a log call: a counter is worth strictly less than the
 * line it is counting, and a monitoring bug must not silence the diagnostics.
 *
 * One coupling to know about: pino skips the hook for a line below the
 * configured level, so counting stops wherever logging stops. At the production
 * default of `info` that covers everything at warn and above, which is the
 * whole set. Raising `LOG_LEVEL` past `warn` would silence the metrics along
 * with the lines -- which is a reason not to, and is written down rather than
 * left to be discovered.
 */
const WARN = 40;
let metrics = null;
function countEvent(level, arg) {
  if (level < WARN || !arg || typeof arg !== 'object' || !arg.event) return;
  try {
    metrics = metrics || require('../services/metrics');
    metrics.increment('splite_events_total', {
      event: String(arg.event),
      level: level >= 50 ? 'error' : 'warn'
    });
  } catch { /* the log line matters more than the count of it */ }
}

const logger = pino({
  level: config.log.level,
  base: { service: 'splite-api', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  hooks: {
    logMethod(args, method, level) {
      countEvent(level, args[0]);
      return method.apply(this, args);
    }
  },
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  // Merged into every line, so requestId / restaurantId / userId appear without
  // any call site having to pass them. See contextSnapshot above for why this
  // must not hand back the live store.
  mixin: contextSnapshot
});

/**
 * Runs fn with a per-request context.
 *
 * The store is deliberately mutable: the tenant and user are not known until
 * authentication has run, several middlewares after the context is created.
 */
function runWithContext(context, fn) {
  return storage.run({ ...context }, fn);
}

/** The active request's context, or an empty object outside a request. */
function getContext() {
  return storage.getStore() ?? {};
}

/** Adds fields to the active context; a no-op outside a request. */
function addContext(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
  return store;
}

module.exports = { logger, runWithContext, getContext, addContext, contextSnapshot, REDACT_PATHS };
