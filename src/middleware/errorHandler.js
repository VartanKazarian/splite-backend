function errorHandler(err, req, res, next) {
    console.error(`[Error] ${err.message}`, { stack: err.stack });

    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
        error: {
            message: err.message || 'Internal Server Error',
            ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
        }
    });
}

module.exports = errorHandler;
