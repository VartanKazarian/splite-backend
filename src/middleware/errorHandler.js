const { logger } = require('../connectors/logger');

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args).
function errorHandler(err, req, res, next) {
  const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  // A 4xx is the caller's problem and routine; a 5xx is ours and is not.
  // Splitting them keeps an alert on `level >= 50` meaningful instead of
  // firing on every malformed request.
  const level = statusCode >= 500 ? 'error' : 'warn';

  // requestId, restaurantId and userId arrive from the request context, so they
  // do not need repeating here. The stack rides on `err`, which pino serialises
  // and redacts; it is not echoed to the client either way.
  logger[level](
    {
      event: 'REQUEST_FAILED',
      method: req.method,
      path: req.originalUrl,
      status: statusCode,
      err
    },
    err.message
  );

  if (res.headersSent) return next(err);

  res.status(statusCode).json({
    error: {
      // 5xx messages are never echoed back: they routinely contain driver,
      // query or file-path detail.
      message: statusCode >= 500 ? 'Internal Server Error' : err.message,
      requestId: req.id
    }
  });
}

module.exports = errorHandler;
