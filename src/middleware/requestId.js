const crypto = require('crypto');

/**
 * Attaches a correlation id to every request so audit rows, logs and error
 * responses can be tied together without leaking internals to the client.
 */
function requestId(req, res, next) {
  const incoming = req.get('x-request-id');
  req.id = /^[A-Za-z0-9._-]{8,128}$/.test(incoming || '') ? incoming : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

module.exports = requestId;
