// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args).
function errorHandler(err, req, res, next) {
  const statusCode = Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600
    ? err.statusCode
    : 500;

  const log = statusCode >= 500 ? console.error : console.warn;
  log('[Error]', {
    requestId: req.id,
    method: req.method,
    path: req.originalUrl,
    status: statusCode,
    message: err.message,
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack
  });

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
