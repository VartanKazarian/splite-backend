const { logger } = require('../connectors/logger');
const { ApiError } = require('../errors');

/**
 * The only place in the app that renders an error body.
 *
 * Every failure arrives here by being thrown or passed to next(), so the
 * envelope is guaranteed by construction rather than by 45 call sites each
 * remembering to build it the same way.
 */
/**
 * Only reachable if something throws a plain Error with a statusCode. Every
 * site in the tree raises an ApiError, so this exists so that a future one that
 * forgets still produces a valid envelope rather than a malformed body.
 */
const FALLBACK_CODES = {
  400: 'VALIDATION_FAILED',
  401: 'AUTH_TOKEN_INVALID',
  403: 'FORBIDDEN_ROLE',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED'
};
const genericFallback = status => (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');

function errorHandler(err, req, res, next) {
  // An ApiError was raised deliberately and its message is written for a
  // caller. Anything else is a bug, and its message is withheld: unexpected
  // errors routinely carry driver, query or file-path detail.
  const known = err instanceof ApiError;

  // Legacy `statusCode` on a plain Error still selects the status, so a throw
  // site that has not been converted yet degrades to a correct status with a
  // generic code rather than becoming a 500.
  const statusCode = known
    ? err.statusCode
    : (Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500);

  const code = known ? err.code : (FALLBACK_CODES[statusCode] ?? genericFallback(statusCode));

  // A 4xx is the caller's problem and routine; a 5xx is ours and is not.
  // Splitting them keeps an alert on `level >= 50` meaningful instead of
  // firing on every malformed request.
  const level = statusCode >= 500 ? 'error' : 'warn';

  // requestId, restaurantId and userId arrive from the request context, so they
  // do not need repeating here. The stack rides on `err`, which pino serialises
  // and redacts; it is not echoed to the client either way.
  //
  // Only when it says something. A deliberate ApiError below 500 -- a wrong
  // password, a 404, a validation failure -- was raised on purpose at a line
  // nobody needs to find, and its stack was a dozen frames of Express per
  // routine request. A 5xx, or anything that is not an ApiError, still logs
  // the whole error: that is a bug and the stack is how it gets found.
  //
  // The path without its query string. Query strings carry filters and dates
  // today; nothing guarantees they never carry something a log should not keep.
  const routine = known && statusCode < 500;
  logger[level](
    {
      event: 'REQUEST_FAILED',
      method: req.method,
      path: `${req.baseUrl || ''}${req.path || ''}` || String(req.originalUrl || '').split('?')[0],
      status: statusCode,
      code,
      ...(routine ? {} : { err })
    },
    err.message
  );

  if (res.headersSent) return next(err);

  res.status(statusCode).json({
    error: {
      code,
      // 5xx messages are never echoed back.
      message: statusCode >= 500 ? 'Internal Server Error' : err.message,
      // Always an object, never absent: `error.details.billId` must not throw
      // on the responses that carry nothing extra.
      details: known ? (err.details ?? {}) : {},
      requestId: req.id
    }
  });
}

module.exports = errorHandler;
