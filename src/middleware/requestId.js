const crypto = require('crypto');
const { runWithContext } = require('../connectors/logger');

/**
 * Attaches a correlation id to every request and opens the logging context.
 *
 * The id ties audit rows, log lines and the error response together without
 * leaking internals to the client. Opening the AsyncLocalStorage context here
 * — before anything else runs — means every later log line carries the id
 * whether or not the code doing the logging has a request object to hand.
 *
 * The tenant and user are added later, by authenticateToken, because they are
 * not known until a token has been verified.
 */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = /^[A-Za-z0-9._-]{8,128}$/.test(incoming || '') ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);

  runWithContext({ requestId: req.id }, () => next());
}

module.exports = requestId;
