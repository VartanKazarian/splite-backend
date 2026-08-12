const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/**
 * What a process needs before it may run.
 *
 * A deploy failed on this: `npm run migrate` imports config transitively, and
 * config validated every signing secret at import time, so the pre-deploy step
 * died on a JWT_ACCESS_SECRET a migration would never read. Secrets are now
 * resolved on first access and the production checks live in a function the
 * *server* calls.
 *
 * These run in a scratch directory because config.js calls dotenv, which reads
 * a .env from the working directory. Testing this from the repository root
 * would quietly pass no matter what the code did -- which is exactly what
 * happened the first time.
 */
const CONFIG = path.join(__dirname, '..', 'src', 'config.js');
const SCRATCH = require('node:os').tmpdir();

const runNode = (script, env) => {
  try {
    return {
      ok: true,
      out: execFileSync(process.execPath, ['-e', script], {
        cwd: SCRATCH,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        encoding: 'utf8'
      })
    };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
};

test('config imports in production without any signing secret', () => {
  // The migration path. It needs a database URL and nothing else.
  const result = runNode(
    `require(${JSON.stringify(CONFIG)}); console.log('imported');`,
    { NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' }
  );
  assert.ok(result.ok, `importing config demanded a secret it does not need:\n${result.out}`);
  assert.match(result.out, /imported/);
});

test('a server refuses to start without them', () => {
  const result = runNode(
    `require(${JSON.stringify(CONFIG)}).assertProductionConfig();`,
    { NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', CORS_ORIGINS: 'https://x.example.com' }
  );
  assert.ok(!result.ok, 'a missing secret must stop a process that serves traffic');
  assert.match(result.out, /Missing required environment variable: JWT_ACCESS_SECRET/);
});

test('reused, short and placeholder secrets are all refused', () => {
  const long = 'a'.repeat(64);
  const base = {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', CORS_ORIGINS: 'https://x.example.com'
  };
  const assertConfig = `require(${JSON.stringify(CONFIG)}).assertProductionConfig();`;

  // One secret used twice means a token minted for one purpose is valid for the other.
  const reused = runNode(assertConfig, {
    ...base,
    JWT_ACCESS_SECRET: long, JWT_REFRESH_SECRET: long,
    QR_SIGNING_SECRET: `${long}b`, WEBHOOK_SECRET: `${long}c`
  });
  assert.ok(!reused.ok);
  assert.match(reused.out, /must all be distinct/);

  const short = runNode(assertConfig, {
    ...base,
    JWT_ACCESS_SECRET: 'a', JWT_REFRESH_SECRET: 'b', QR_SIGNING_SECRET: 'c', WEBHOOK_SECRET: 'd'
  });
  assert.ok(!short.ok);
  assert.match(short.out, /at least 32 characters/);
});

test('CORS origins are required, and a wildcard is refused', () => {
  const secrets = {
    JWT_ACCESS_SECRET: 'a'.repeat(64), JWT_REFRESH_SECRET: 'b'.repeat(64),
    QR_SIGNING_SECRET: 'c'.repeat(64), WEBHOOK_SECRET: 'd'.repeat(64)
  };
  const assertConfig = `require(${JSON.stringify(CONFIG)}).assertProductionConfig();`;

  const missing = runNode(assertConfig, { NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', ...secrets });
  assert.ok(!missing.ok);
  assert.match(missing.out, /CORS_ORIGINS is required/);

  const wildcard = runNode(assertConfig, {
    NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', CORS_ORIGINS: '*', ...secrets
  });
  assert.ok(!wildcard.ok);
  assert.match(wildcard.out, /Wildcard CORS origin/);
});
