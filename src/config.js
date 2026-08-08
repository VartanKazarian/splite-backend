require('dotenv').config();

const isProduction = process.env.NODE_ENV === 'production';

const DEV_PLACEHOLDER = 'dev-only-change-me';
const MIN_SECRET_LENGTH = 32;

function integer(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Secrets are mandatory in production. In development a deterministic
 * placeholder is used so the app boots, but the placeholder can never
 * survive a production start (see the guard below).
 */
function secret(name) {
  const value = process.env[name];
  if (value) return value;
  if (isProduction) throw new Error(`Missing required environment variable: ${name}`);
  return `${DEV_PLACEHOLDER}-${name.toLowerCase()}`;
}

const secrets = {
  jwtAccessSecret: secret('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: secret('JWT_REFRESH_SECRET'),
  qrSigningSecret: secret('QR_SIGNING_SECRET'),
  webhookSecret: secret('WEBHOOK_SECRET')
};

if (isProduction) {
  for (const [name, value] of Object.entries(secrets)) {
    if (value.includes(DEV_PLACEHOLDER)) throw new Error(`Insecure default secret configured: ${name}`);
    if (value.length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  const distinct = new Set(Object.values(secrets));
  if (distinct.size !== Object.keys(secrets).length) throw new Error('Signing secrets must all be distinct');
  if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) throw new Error('DATABASE_URL or DB_PASSWORD is required in production');
  if (!process.env.CORS_ORIGINS) throw new Error('CORS_ORIGINS is required in production');
}

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(v => v.trim()).filter(Boolean);

if (isProduction && corsOrigins.includes('*')) throw new Error('Wildcard CORS origin is not allowed in production');

module.exports = {
  port: integer('PORT', 3000),
  env: process.env.NODE_ENV || 'development',
  isProduction,
  corsOrigins,
  jwt: {
    accessSecret: secrets.jwtAccessSecret,
    refreshSecret: secrets.jwtRefreshSecret,
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlSeconds: integer('JWT_REFRESH_TTL_SECONDS', 60 * 60 * 24 * 30),
    issuer: 'splite-api',
    audience: 'splite'
  },
  qrSigningSecret: secrets.qrSigningSecret,
  qrTtlSeconds: integer('QR_TTL_SECONDS', 60 * 60 * 24 * 30),
  webhookSecret: secrets.webhookSecret,
  webhookToleranceSeconds: integer('WEBHOOK_TOLERANCE_SECONDS', 300),
  guest: {
    sessionTtlSeconds: integer('GUEST_SESSION_TTL_SECONDS', 60 * 60 * 2)
  },
  db: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: integer('DB_PORT', 5432),
    user: process.env.DB_USER || 'splite',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'splite_db',
    ssl: boolean('DB_SSL', isProduction),
    poolMax: integer('DB_POOL_MAX', 20)
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL || null,
  rateLimit: {
    // Fail closed on authentication endpoints: a Redis outage must not
    // silently disable brute-force protection on the login surface.
    failClosedOnAuth: boolean('RATE_LIMIT_FAIL_CLOSED_ON_AUTH', isProduction)
  },
  trustProxy: integer('TRUST_PROXY', isProduction ? 1 : 0)
};
