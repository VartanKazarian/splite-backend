const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const swaggerUi = require('swagger-ui-express');

const config = require('./config');
const db = require('./connectors/base');
const { redis } = require('./connectors/redis');
const requestId = require('./middleware/requestId');
const { isShuttingDown } = require('./lifecycle');
const openapi = require('./openapi');
const { logger } = require('./connectors/logger');
const rateLimit = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const metrics = require('./services/metrics');
const { safeEqual } = require('./utils/tokens');
const { ApiError } = require('./errors');
const authRoutes = require('./routes/auth');
const guestRoutes = require('./routes/guest');
const billRoutes = require('./routes/bills');
const exchangeRateRoutes = require('./routes/exchangeRate');
const menuRoutes = require('./routes/menu');
const tableRoutes = require('./routes/tables');
const onboardingRoutes = require('./routes/onboarding');
const accountRoutes = require('./routes/account');
const paymentRoutes = require('./routes/payments');
const webhookRoutes = require('./routes/webhooks');

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
    // The rejected origin is echoed back deliberately. A browser reports a
    // blocked request as a generic CORS failure and never says which origin
    // the server refused, so the one fact needed to fix it -- the exact string
    // to add to CORS_ORIGINS -- is the one nobody can see. It reveals nothing:
    // the caller sent it.
    return callback(new ApiError(
      'CORS_ORIGIN_NOT_ALLOWED',
      `Origin ${origin} is not allowed. Add it to CORS_ORIGINS.`,
      { origin }
    ));
  },
  credentials: true,
  methods: config.corsMethods,
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

/**
 * Prometheus exposition, beside the health checks and for the same reasons:
 * ahead of body parsing and of the rate limiter, so a scrape every fifteen
 * seconds never consumes a client's request budget and never fails because
 * Redis is down.
 *
 * Mounted only when a token is configured. Absent means 404 rather than 401 --
 * an endpoint that exists but refuses is an endpoint somebody probes, and this
 * one names every queue in the installation and how far behind each is.
 */
if (config.metrics.token) {
  metrics.registerQueueGauges();
  app.get('/metrics', async (req, res, next) => {
    const [scheme, token] = (req.get('authorization') || '').split(' ');
    // Constant-time, and the same helper the QR signature uses: a scrape
    // endpoint is still a credential check.
    if (scheme !== 'Bearer' || !token || !safeEqual(token, config.metrics.token)) {
      return next(new ApiError('AUTH_TOKEN_INVALID', 'Invalid or missing metrics token'));
    }
    try {
      res.type('text/plain; version=0.0.4; charset=utf-8').send(await metrics.render());
    } catch (err) { next(err); }
  });
}

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
// A coarse backstop only, and deliberately generous. It runs before any guest
// authentication, so it can key on nothing but the address -- and a whole
// restaurant of diners arrives from one carrier NAT address. The tight,
// meaningful limit is per session, applied inside the router once the session
// has been verified; 30 a minute here was one shared bucket for every table in
// the room, which throttled a busy Friday rather than an abuser.
app.use('/api/v1/guest', rateLimit({ windowSeconds: 60, max: 240, keyPrefix: 'guest' }), guestRoutes);
// bills and tables carry their own limiter, mounted after authentication so it
// keys on the staff member rather than on a shared NAT address.
app.use('/api/v1/bills', billRoutes);
// The machine-readable contract, and a browsable view of it. Mounted after the
// body parsers but before the routes so it is never shadowed by a wildcard.
if (openapi.enabled) {
  app.get('/openapi.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(openapi.document);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi.document, {
    customSiteTitle: 'Splite API',
    swaggerOptions: { displayRequestDuration: true }
  }));
}

app.use('/api/v1/tables', tableRoutes);
app.use('/api/v1/exchange-rate', exchangeRateRoutes);
// The public menu endpoint inside this router is intentionally unauthenticated,
// so it relies on the app-level limiter above.
app.use('/api/v1/menu', menuRoutes);
app.use('/api/v1/account', accountRoutes);
app.use('/api/v1/payments', paymentRoutes);

// A SEPARATE router object, mounted at exactly one path. Serving webhooks by
// mounting the payments router under a second prefix makes every payment route
// answer there too, and any middleware attached by prefix -- authentication,
// rate limiting -- is then skipped by changing the URL.
app.use('/api/v1/webhooks', webhookRoutes);

// Mounted only when self-service registration is switched on. The route is the
// one public write surface that creates tenants and sends mail, so its absence
// is the default state rather than something that has to be remembered: a
// deployment without a mail provider configured simply does not serve it, and
// config.assertProductionConfig refuses to start if the flag is on without one.
// Its limiters live in the router, keyed per source address and per recipient.
if (config.onboarding.enabled) {
  app.use('/api/v1/onboarding', onboardingRoutes);
} else {
  // Off, and saying so. The router -- with its two fail-closed limiters and the
  // only public write surface that creates tenants -- is still not mounted;
  // this is a leaf that reads nothing and throws. It exists because the
  // alternative was the catch-all 404 below, which a client cannot tell from a
  // mistyped path: the first frontend to meet it rendered an invented support
  // address, because there was nothing truthful left to say.
  app.use('/api/v1/onboarding', (req, res, next) => {
    next(new ApiError('ONBOARDING_NOT_CONFIGURED', 'Registration is not enabled on this deployment'));
  });
}

app.use((req, res, next) => next(new ApiError('NOT_FOUND', 'Not found')));
app.use(errorHandler);

module.exports = app;
