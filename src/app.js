const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');

const config = require('./config');
const db = require('./connectors/base');
const { redis } = require('./connectors/redis');
const requestId = require('./middleware/requestId');
const rateLimit = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const authRoutes = require('./routes/auth');
const guestRoutes = require('./routes/guest');
const billRoutes = require('./routes/bills');
const tableRoutes = require('./routes/tables');

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

morgan.token('id', req => req.id);
app.use(morgan(
  config.isProduction ? ':id :remote-addr :method :url :status :response-time ms' : 'dev',
  { skip: req => req.path.startsWith('/health') }
));

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
app.use('/api/v1/tables', tableRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use(errorHandler);

module.exports = app;
