const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');

const config = require('./config');
const db = require('./connectors/base');
const { redis } = require('./connectors/redis');
const requestId = require('./middleware/requestId');
const { isShuttingDown } = require('./lifecycle');
const { logger } = require('./connectors/logger');
const rateLimit = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const guestRoutes = require('./routes/guest');
const billRoutes = require('./routes/bills');
const exchangeRateRoutes = require('./routes/exchangeRate');
const menuRoutes = require('./routes/menu');

const app = express();

app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');
app.set('etag', false);

app.use(requestId);

app.use(helmet({
  hsts: config.isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  // JSON API: a restrictive CSP with no rendered HTML surface adds nothing,
  // but frameguard/noSniff/referrerPolicy from helmet's defaults still apply.
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' }
}));

app.use(cors({
  origin(origin, callback) {
    // No Origin header: server-to-server, curl, mobile clients.
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
    const error = new Error('CORS origin not allowed');
    error.statusCode = 403;
    return callback(error);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id', 'X-Guest-Session'],
  exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'Retry-After'],
  maxAge: 600
}));

// Health checks sit ahead of body parsing and rate limiting so a probe never
// consumes a client's request budget and never fails because Redis is down.
app.get('/health/live', (req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', async (req, res) => {
  // Readiness fails the moment a shutdown starts, so the load balancer stops
  // sending new requests while in-flight ones drain. Liveness deliberately
  // keeps answering 200: failing it would have the orchestrator kill the
  // process outright instead of letting it finish.
  if (isShuttingDown()) {
    return res.status(503).json({ status: 'shutting_down' });
  }

  const checks = await Promise.allSettled([db.query('SELECT 1'), redis.ping()]);
  const ready = checks.every(c => c.status === 'fulfilled');
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    postgres: checks[0].status === 'fulfilled' ? 'up' : 'down',
    redis: checks[1].status === 'fulfilled' ? 'up' : 'down'
  });
});

// rawBody is captured for HMAC webhook verification, which must sign the exact
// bytes received rather than a re-serialised object.
app.use(express.json({ limit: '256kb', verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

/**
 * Access logging.
 *
 * Morgan emitted a formatted string, so the request id it carried could not be
 * correlated with anything a service logged, and nothing else in a line was
 * queryable. Every request now produces one JSON object sharing the same
 * requestId, restaurantId and userId as the logs emitted while handling it.
 */
app.use(pinoHttp({
  logger,
  // The context already carries these; repeating them per line is noise.
  customProps: () => ({ event: 'REQUEST_COMPLETED' }),
  // 4xx is the caller's problem, 5xx is ours; the error handler logs the
  // detail, so this is only the access record.
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Probes would otherwise dominate the log volume.
  autoLogging: { ignore: req => req.url.startsWith('/health') },
  serializers: {
    req: req => ({ method: req.method, url: req.url, remoteAddress: req.remoteAddress }),
    res: res => ({ statusCode: res.statusCode })
  }
}));

app.use(rateLimit({ windowSeconds: 60, max: 120, keyPrefix: 'api' }));

app.use('/api/v1/auth', rateLimit({
  windowSeconds: 60,
  max: 10,
  keyPrefix: 'auth',
  failClosed: config.rateLimit.failClosedOnAuth
}), authRoutes);
app.use('/api/v1/guest', rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'guest' }), guestRoutes);
// bills and tables carry their own limiter, mounted after authentication so it
// keys on the staff member rather than on a shared NAT address.
app.use('/api/v1/bills', billRoutes);
app.use('/api/v1/exchange-rate', exchangeRateRoutes);
// The public menu endpoint inside this router is intentionally unauthenticated,
// so it relies on the app-level limiter above.
app.use('/api/v1/menu', menuRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
