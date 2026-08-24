const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

/**
 * What a refused start says, and where it says it.
 *
 * A production deploy was rejected over one environment variable and the
 * dashboard reported it as four healthcheck retries and "replicas never became
 * healthy" -- true, and useless. The reason was in the logs the whole time, as
 * a single ~1KB JSON object on stdout, and three separate attempts to find it
 * failed because the viewer collapsed the line.
 *
 * So the reason is also written to stderr in plain text, and these pin that it
 * carries the cause rather than a category, and that it survives the log level
 * being turned down -- silencing telemetry must not silence the one message
 * explaining why nothing is running.
 */
const SERVER = path.join(__dirname, '..', 'src', 'server.js');

// A scratch cwd because config.js calls dotenv, which reads a .env from the
// working directory: run from the repository root, these would pass on the
// developer's own configuration no matter what the code did.
const SCRATCH = os.tmpdir();

const SECRET = size => String.fromCharCode(97 + size).repeat(64);

const PRODUCTION = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user@127.0.0.1:1/db',
  CORS_ORIGINS: 'https://app.example.com',
  JWT_ACCESS_SECRET: SECRET(0),
  JWT_REFRESH_SECRET: SECRET(1),
  QR_SIGNING_SECRET: SECRET(2),
  WEBHOOK_SECRET: SECRET(3),
  // Onboarding on is what makes the mail settings mandatory, which is the
  // check these exercise. Everything but the transport is valid.
  ONBOARDING_ENABLED: 'true',
  APP_BASE_URL: 'https://app.example.com',
  MAIL_FROM: 'Splite <team@gmail.com>',
  ONBOARDING_TEAM_EMAIL: 'team@gmail.com'
};

const boot = env => {
  const result = spawnSync(process.execPath, [SERVER], {
    cwd: SCRATCH,
    env: { ...PRODUCTION, ...env },
    encoding: 'utf8',
    timeout: 20000
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
};

test('a refused start names the cause in plain text on stderr', () => {
  const { code, stderr } = boot({ MAIL_TRANSPORT: 'resend', MAIL_API_KEY: 're_test_key' });

  assert.equal(code, 1, 'a process that never listened must exit non-zero');
  assert.match(stderr, /STARTUP FAILED/);
  // The specific variable and the remedy, not "configuration error": the whole
  // failure mode being fixed is a message that says something went wrong
  // without saying which setting to change.
  assert.match(stderr, /cannot be used with MAIL_TRANSPORT=resend/);
  assert.match(stderr, /Use MAIL_TRANSPORT=smtp/);
});

test('the structured record and the plain reason are on separate streams', () => {
  const { code, stdout, stderr } = boot({ MAIL_TRANSPORT: 'resend' });

  assert.equal(code, 1);
  // Two audiences, two streams, and the duplication is deliberate. A viewer
  // showing only one of them -- or collapsing the 1KB JSON object, which is
  // what sent three separate searches looking in the wrong place -- still
  // leaves a reader the sentence naming the variable.
  assert.match(stdout, /"event":"STARTUP_FAILED"/);
  assert.doesNotMatch(stdout, /STARTUP FAILED:/);
  assert.match(stderr, /STARTUP FAILED: MAIL_API_KEY is required for MAIL_TRANSPORT=resend/);
  assert.doesNotMatch(stderr, /"event":"STARTUP_FAILED"/);
});

// LOG_LEVEL cannot be used to suppress the structured half in production:
// assertProductionConfig refuses a level above `warn` because it would silence
// the metrics counted with those lines. Worth pinning here too -- it is the
// reason the stderr banner is a second channel rather than the only one.
test('production refuses a log level that would hide the structured record', () => {
  const { code, stderr } = boot({ MAIL_TRANSPORT: 'smtp', LOG_LEVEL: 'silent' });

  assert.equal(code, 1);
  assert.match(stderr, /STARTUP FAILED: LOG_LEVEL=silent would silence warnings/);
});

test('a healthy configuration gets past the config gate', () => {
  // No database is listening on port 1, so start() proceeds past
  // assertProductionConfig and dies at `db.query('SELECT 1')` instead. That is
  // the assertion: the mail settings were accepted, and the next failure is a
  // different one.
  const { code, stderr } = boot({
    MAIL_TRANSPORT: 'smtp',
    MAIL_SMTP_HOST: 'smtp.gmail.com',
    MAIL_SMTP_USER: 'team@gmail.com',
    MAIL_SMTP_PASSWORD: 'abcdefghijklmnop'
  });

  assert.equal(code, 1);
  assert.doesNotMatch(stderr, /MAIL_/, 'a valid mail configuration must not be what stops the boot');
  assert.match(stderr, /STARTUP FAILED/);
});
