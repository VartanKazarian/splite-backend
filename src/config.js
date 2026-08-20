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

const SECRET_ENV = {
  jwtAccessSecret: 'JWT_ACCESS_SECRET',
  jwtRefreshSecret: 'JWT_REFRESH_SECRET',
  qrSigningSecret: 'QR_SIGNING_SECRET',
  webhookSecret: 'WEBHOOK_SECRET'
};

// Resolved on first read rather than at import. `npm run migrate` needs a
// database URL and nothing else, and importing config used to demand all four
// signing secrets -- so a deploy's pre-deploy step failed on a
// JWT_ACCESS_SECRET the migration would never read.
const resolved = new Map();
function secretValue(key) {
  if (!resolved.has(key)) resolved.set(key, secret(SECRET_ENV[key]));
  return resolved.get(key);
}

const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',').map(v => v.trim()).filter(Boolean);

// Read once here because assertProductionConfig and the exported object both
// need them, and the guard runs before the export is consulted.
const onboardingEnabled = boolean('ONBOARDING_ENABLED', false);
const mailTransport = process.env.MAIL_TRANSPORT || 'log';

/**
 * Everything a process that *serves traffic* must have before it accepts any.
 *
 * Called by src/server.js at startup, deliberately not at import time. A
 * command-line tool that only touches the database gets to run without the
 * app's signing secrets, while the server still fails fast rather than
 * discovering a missing secret on its first login.
 */
function assertProductionConfig() {
  if (!isProduction) return;

  const values = Object.fromEntries(
    Object.keys(SECRET_ENV).map(key => [key, secretValue(key)])
  );
  for (const [name, value] of Object.entries(values)) {
    if (value.includes(DEV_PLACEHOLDER)) throw new Error(`Insecure default secret configured: ${name}`);
    if (value.length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  // Reusing one secret for two purposes means a token minted for one is valid
  // for the other.
  if (new Set(Object.values(values)).size !== Object.keys(values).length) {
    throw new Error('Signing secrets must all be distinct');
  }

  if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
    throw new Error('DATABASE_URL or DB_PASSWORD is required in production');
  }
  if (!process.env.CORS_ORIGINS) throw new Error('CORS_ORIGINS is required in production');
  if (corsOrigins.includes('*')) throw new Error('Wildcard CORS origin is not allowed in production');

  // Scoped to the flag rather than asserted unconditionally, so that deploying
  // self-service onboarding does not stop a running production API that has no
  // mail provider configured yet. Turning ONBOARDING_ENABLED on is what makes
  // these mandatory -- and it must, because a registration flow whose
  // verification mail goes to a log file is a flow where nobody ever finishes
  // registering.
  if (!onboardingEnabled) return;

  if (mailTransport === 'log') {
    throw new Error('MAIL_TRANSPORT=log cannot be used in production with ONBOARDING_ENABLED=true');
  }
  if (!process.env.MAIL_FROM) throw new Error('MAIL_FROM is required when onboarding is enabled');
  if (!process.env.APP_BASE_URL) throw new Error('APP_BASE_URL is required when onboarding is enabled');
  // The registration form's entire purpose is to reach this address. Defaulting
  // it in production would mean submissions succeed, return 202, and are read
  // by nobody -- the failure mode a lead-capture form cannot be allowed to have.
  if (!process.env.ONBOARDING_TEAM_EMAIL) {
    throw new Error('ONBOARDING_TEAM_EMAIL is required when onboarding is enabled');
  }
  if (mailTransport === 'resend' && !process.env.MAIL_API_KEY) {
    throw new Error('MAIL_API_KEY is required for MAIL_TRANSPORT=resend');
  }
}

module.exports = {
  assertProductionConfig,
  port: integer('PORT', 3000),
  env: process.env.NODE_ENV || 'development',
  isProduction,
  corsOrigins,
  jwt: {
    get accessSecret() { return secretValue('jwtAccessSecret'); },
    get refreshSecret() { return secretValue('jwtRefreshSecret'); },
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtlSeconds: integer('JWT_REFRESH_TTL_SECONDS', 60 * 60 * 24 * 30),
    issuer: 'splite-api',
    audience: 'splite'
  },
  get qrSigningSecret() { return secretValue('qrSigningSecret'); },
  // 0 means no expiry, which is the default: a table QR is printed onto a
  // sticker and has to keep working. Revocation is rotating the table's nonce,
  // not waiting for a clock. Set a positive value to mint expiring codes.
  qrTtlSeconds: integer('QR_TTL_SECONDS', 0),
  get webhookSecret() { return secretValue('webhookSecret'); },
  webhookToleranceSeconds: integer('WEBHOOK_TOLERANCE_SECONDS', 300),
  guest: {
    // Idle timeout, not a total lifetime: every authenticated request pushes it
    // back. Two hours of *silence* from a table means the diner has gone.
    sessionTtlSeconds: integer('GUEST_SESSION_TTL_SECONDS', 60 * 60 * 2),
    // The ceiling a sliding session cannot pass, however much it is used. Long
    // enough that no real sitting reaches it, short enough that a phone left on
    // a table overnight does not hold a valid credential in the morning.
    maxSessionAgeSeconds: integer('GUEST_MAX_SESSION_AGE_SECONDS', 60 * 60 * 12)
  },
  mail: {
    transport: mailTransport,
    from: process.env.MAIL_FROM || 'Splite <onboarding@localhost>',
    // Not in SECRET_ENV: that set is the signing secrets, which are required in
    // production, must be 32+ characters and must all differ from each other.
    // A provider's API key satisfies none of those rules and would fail the
    // start-up guard for a service that may not use mail at all.
    apiKey: process.env.MAIL_API_KEY || null,
    timeoutMs: integer('MAIL_TIMEOUT_MS', 10000)
  },
  onboarding: {
    // Off by default. The routes are only mounted when this is on, so the
    // public registration surface does not exist until somebody deliberately
    // turns it on with a mail provider behind it.
    enabled: onboardingEnabled,
    // Long enough to survive a spam folder and a night's sleep; short enough
    // that a link forwarded or logged somewhere stops working.
    tokenTtlSeconds: integer('ONBOARDING_TOKEN_TTL_SECONDS', 60 * 60 * 48),
    trialDays: integer('TRIAL_DAYS', 30),
    // Where the verification link points -- the frontend, not this API. The
    // page there reads the token and posts it back to /onboarding/verify.
    appBaseUrl: (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    // Who at Splite reads the submissions and telephones the restaurant. This
    // is the address the whole flow exists to reach: the applicant's
    // acknowledgement is courtesy, but a lead nobody is told about is a lead
    // that dies in a table.
    teamEmail: process.env.ONBOARDING_TEAM_EMAIL || 'onboarding@localhost'
  },
  db: {
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST || 'localhost',
    port: integer('DB_PORT', 5432),
    user: process.env.DB_USER || 'splite',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'splite_db',
    ssl: boolean('DB_SSL', isProduction),
    poolMax: integer('DB_POOL_MAX', 20),

    // These solve different problems and none substitutes for another.
    //
    // connectionTimeoutMs bounds how long we wait to *obtain* a pooled
    // connection. It says nothing about how long a query may then run for.
    connectionTimeoutMs: integer('DB_CONNECTION_TIMEOUT_MS', 5000),
    idleTimeoutMs: integer('DB_IDLE_TIMEOUT_MS', 30000),

    // statement_timeout bounds a single statement, server-side, so Postgres
    // cancels it rather than the client merely giving up while the query keeps
    // burning a backend.
    statementTimeoutMs: integer('DB_STATEMENT_TIMEOUT_MS', 5000),

    // A transaction left open holds its row locks. processSplitPayment takes
    // SELECT ... FOR UPDATE on a bill, so a client that stalls mid-transaction
    // blocks every other diner paying that bill until the connection dies.
    // This bounds that to something finite.
    idleInTransactionTimeoutMs: integer('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 10000),

    // The payment path gets its own, larger budget.
    //
    // Not because the queries are slow -- they are a locked read and two
    // writes -- but because *waiting for the lock counts toward
    // statement_timeout*. Several diners paying at once queue behind each
    // other, so the last one in a busy split can legitimately spend most of
    // its budget blocked rather than working.
    paymentStatementTimeoutMs: integer('DB_PAYMENT_STATEMENT_TIMEOUT_MS', 15000)
  },
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379'
  },
  fx: {
    // USD is a display reference only; settlement is always VES. Disabling
    // this omits the USD line, it does not stop payments.
    enabled: boolean('FX_ENABLED', true),
    // BCV publishes the official rate as Drupal HTML; there is no JSON API.
    // Overridable so a mirror or a fixture can be used instead.
    url: process.env.EXCHANGE_RATE_API_URL || 'https://www.bcv.org.ve/',
    source: process.env.EXCHANGE_RATE_SOURCE || 'BCV',
    // BCV's own cache-control is max-age=300 and the figure changes at most
    // once per business day, so polling harder buys nothing.
    ttlMs: integer('FX_CACHE_TTL_SECONDS', 900) * 1000,
    timeoutMs: integer('FX_TIMEOUT_MS', 8000),
    // Reject a rate that jumps more than this from the last known good value:
    // a page that changes shape can yield a plausible but wrong number, and
    // silently repricing every menu is worse than showing no USD line.
    maxDeviationPct: Number(process.env.FX_MAX_DEVIATION_PCT || 5),
    // How far back the last known in-force rate may be used when BCV cannot be
    // reached. BCV publishes on business days, so a long weekend with a public
    // holiday either side is the widest normal gap -- five days covers it
    // without letting a genuine multi-week outage price bills on a figure that
    // has stopped being true.
    maxFallbackAgeDays: integer('FX_MAX_FALLBACK_AGE_DAYS', 5),
    minRate: Number(process.env.FX_MIN_RATE || 1),
    maxRate: Number(process.env.FX_MAX_RATE || 1e9),
    // bcv.org.ve serves an incomplete certificate chain: it presents the wrong
    // Sectigo intermediate, so the leaf cannot be verified against Node's root
    // store on its own. curl and openssl hide this by fetching the missing
    // certificate themselves; Node does not. We ship the correct intermediate
    // and add it to the trust list. Verification stays fully enabled.
    extraCaFile: process.env.EXCHANGE_RATE_EXTRA_CA
      || require('path').join(__dirname, '..', 'certs', 'sectigo-public-server-auth-dv-r36.pem')
  },
  docs: {
    // The spec is a contract that frontends and payment providers consume, so
    // it is served by default. It documents shapes and status codes, not
    // secrets, and the API surface is not itself confidential. Set
    // DOCS_ENABLED=false to withhold it and distribute openapi.json out of band
    // instead.
    enabled: boolean('DOCS_ENABLED', true)
  },
  log: {
    // debug in development, info in production. `silent` is honoured too, which
    // the test suite uses to keep output readable.
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug')
  },
  auth: {
    // Failed logins counted per account, closing the gap the address limiter
    // leaves: attempts spread over many addresses against one account.
    //
    // Generous on purpose. This is cost control and a detection signal, not a
    // cryptographic bound -- passwords are created with a twelve character
    // minimum and each attempt costs an Argon2id verify, so guessing was never
    // the exposure. A tight threshold would instead hand anyone who knows an
    // owner's email a way to shut their restaurant out of its own till.
    maxAccountFailures: integer('AUTH_MAX_ACCOUNT_FAILURES', 20),
    // Short and self-healing, for the same reason. Nothing here ever becomes a
    // lock that needs a human to lift.
    accountFailureWindowSeconds: integer('AUTH_ACCOUNT_FAILURE_WINDOW_SECONDS', 900)
  },
  rateLimit: {
    // Fail closed on authentication endpoints: a Redis outage must not
    // silently disable brute-force protection on the login surface.
    failClosedOnAuth: boolean('RATE_LIMIT_FAIL_CLOSED_ON_AUTH', isProduction)
  },
  payments: {
    /**
     * A key ring, `version:material` comma separated, base64 or hex.
     *
     * A ring rather than a single key because the interesting moment is not the
     * first encryption but the rotation years later: a new version can be added
     * and old rows re-sealed in the background, instead of one migration that
     * must not fail.
     *
     * Read lazily and never asserted at boot. Most deployments will never store
     * bank credentials, and a missing key must break storing them rather than
     * break starting the app.
     */
    credentialKeys: process.env.PAYMENT_CREDENTIALS_KEYS || '',
    activeKeyVersion: integer('PAYMENT_CREDENTIALS_ACTIVE_KEY_VERSION', 1),

    /**
     * Mercantil C2P endpoint wiring.
     *
     * Endpoints only. The credentials are per restaurant and sealed in the
     * database (migration 018), so nothing secret appears here -- a global
     * `MERCANTIL_API_KEY` would mean charging every restaurant through one
     * merchant identity.
     *
     * Empty by default, and a deployment with no base URL simply cannot raise a
     * C2P charge. That is the correct default: the rail is opt-in per
     * deployment as well as per restaurant.
     */
    mercantil: {
      baseUrl: process.env.MERCANTIL_C2P_URL || '',
      chargePath: process.env.MERCANTIL_C2P_CHARGE_PATH || '/payment/c2p',
      searchPath: process.env.MERCANTIL_C2P_SEARCH_PATH || '/payment/search',
      // Generous, and deliberately so. A bank core under load is slow long
      // before it is broken, and every second shaved off this converts a
      // conclusive answer into an IN_DOUBT charge somebody has to resolve by
      // hand.
      timeoutMs: integer('MERCANTIL_C2P_TIMEOUT_MS', 30000),
      // Logs redacted request bodies on a failed call. Off in production: the
      // redaction is thorough, but the safest place for a single-use clave is
      // still a log line that was never written.
      debug: boolean('MERCANTIL_C2P_DEBUG', false)
    }
  },
  menuOcr: {
    /**
     * Reading a menu off a photo with a vision model.
     *
     * Empty by default: a deployment without a key simply cannot use the
     * feature, and says so with 503 rather than failing oddly at upload time.
     * The endpoint is opt-in per deployment for the same reason the C2P rail
     * is -- it costs money per call and reaches a third party.
     *
     * `baseUrl` selects the provider. The request is the OpenAI-compatible
     * chat-completions shape that several vendors serve, so switching is
     * configuration rather than code.
     */
    apiKey: process.env.MENU_OCR_API_KEY || '',
    baseUrl: process.env.MENU_OCR_BASE_URL || 'https://api.openai.com',
    model: process.env.MENU_OCR_MODEL || 'gpt-4o',
    timeoutMs: integer('MENU_OCR_TIMEOUT_MS', 60000),
    maxTokens: integer('MENU_OCR_MAX_TOKENS', 4000),
    // A menu upload is bounded on every axis a stranger controls.
    maxUploadBytes: integer('MENU_OCR_MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
    maxPdfPages: integer('MENU_OCR_MAX_PDF_PAGES', 6),
    pdfTimeoutMs: integer('MENU_OCR_PDF_TIMEOUT_MS', 20000)
  },
  reconcile: {
    /**
     * How long a C2P charge may sit unresolved before the reconciler mentions
     * it. Not a failure -- IN_DOUBT and AMBIGUOUS are correct states -- but the
     * diner has been debited and is waiting on a person, so a queue that has
     * stopped being worked should not stay quiet. Six hours is one service.
     */
    unresolvedC2PHours: integer('RECONCILE_UNRESOLVED_C2P_HOURS', 6),
    /**
     * How long a declared Pago Movil may sit unconfirmed before the reconciler
     * mentions it.
     *
     * Two hours, which is well past any plausible service window for one table:
     * a claim this old is not "busy tonight", it is a queue nobody is working,
     * and the diner who declared it has almost certainly gone home believing
     * they paid. Short enough to catch a whole neglected evening, long enough
     * not to report every claim that took a few minutes to verify.
     */
    unworkedClaimsHours: integer('RECONCILE_UNWORKED_CLAIMS_HOURS', 2)
  },
  purge: {
    // Retention is set by what still reads the row, not by what feels tidy.
    //
    // A dead refresh session cannot authenticate anything; the extra fortnight
    // is so reuse detection has something to point at when somebody asks why a
    // token was refused.
    refreshSessionDays: integer('PURGE_REFRESH_SESSION_DAYS', 14),
    // Must outlast an FX outage, because the rate fallback reads this table to
    // keep bills openable when BCV is unreachable.
    fxRateDays: integer('PURGE_FX_RATE_DAYS', 180),
    // Read when a payment is disputed, which happens within a billing cycle.
    webhookDeliveryDays: integer('PURGE_WEBHOOK_DELIVERY_DAYS', 90),
    // Must outlast provider retry budgets, which run for days. Deleting one of
    // these early lets a late redelivery be treated as a new event.
    webhookEventDays: integer('PURGE_WEBHOOK_EVENT_DAYS', 180),
    // Distinct from the migration runner's lock: a purge running while a
    // migration waits would be a deadlock made out of good intentions.
    lockId: integer('PURGE_ADVISORY_LOCK_ID', 776644)
  },
  trustProxy: integer('TRUST_PROXY', isProduction ? 1 : 0)
};
