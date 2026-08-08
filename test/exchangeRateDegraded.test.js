const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const resilient = require('../src/connectors/resilient');
const config = require('../src/config');
const svc = require('../src/services/exchangeRate');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'bcv-dolar.html'), 'utf8');

const realFetcher = resilient.resilientGetText;
const realFallback = config.exchangeRate.fallbackRate;

/** Replaces the network with a scripted response. */
const stub = impl => { resilient.resilientGetText = impl; };

beforeEach(() => {
  svc.resetCache();
  config.exchangeRate.fallbackRate = null;
});

afterEach(() => {
  resilient.resilientGetText = realFetcher;
  config.exchangeRate.fallbackRate = realFallback;
  svc.resetCache();
});

test('serves the last known rate, flagged stale, when BCV goes down', async () => {
  stub(async () => FIXTURE);
  const good = await svc.getVesPerUsd();
  assert.equal(good.rate, 757.5406);
  assert.equal(good.stale, false);

  stub(async () => { throw new Error('ECONNRESET'); });
  const degraded = await svc.getVesPerUsd({ force: true });

  assert.equal(degraded.rate, 757.5406, 'the last good rate is still served');
  assert.equal(degraded.stale, true, 'but the caller can tell it is not current');
  assert.equal(degraded.source, 'BCV');
  assert.match(degraded.staleReason, /ECONNRESET/);
});

test('throws 503 rather than inventing a rate when none was ever fetched', async () => {
  stub(async () => { throw new Error('ENOTFOUND'); });

  await assert.rejects(
    () => svc.getVesPerUsd(),
    err => {
      assert.equal(err.statusCode, 503);
      assert.match(err.message, /unavailable/i);
      return true;
    }
  );
});

test('an explicitly configured fallback is served but never labelled as BCV', async () => {
  config.exchangeRate.fallbackRate = 700;
  stub(async () => { throw new Error('ENOTFOUND'); });

  const result = await svc.getVesPerUsd();
  assert.equal(result.rate, 700);
  assert.equal(result.source, 'fallback', 'a configured guess must not masquerade as the official rate');
  assert.equal(result.stale, true);
});

test('a malformed page does not overwrite a good cached rate', async () => {
  stub(async () => FIXTURE);
  await svc.getVesPerUsd();

  stub(async () => '<html>mantenimiento</html>');
  const degraded = await svc.getVesPerUsd({ force: true });

  assert.equal(degraded.rate, 757.5406, 'a parse failure is treated like an outage');
  assert.equal(degraded.stale, true);
});

test('concurrent callers on a cold cache make a single upstream request', async () => {
  let calls = 0;
  stub(async () => { calls += 1; return FIXTURE; });

  const results = await Promise.all(Array.from({ length: 8 }, () => svc.getVesPerUsd()));

  assert.equal(calls, 1, 'single-flight: eight callers, one fetch');
  assert.equal(new Set(results.map(r => r.rate)).size, 1);
});

test('a fresh cache is reused without touching the network', async () => {
  let calls = 0;
  stub(async () => { calls += 1; return FIXTURE; });

  await svc.getVesPerUsd();
  await svc.getVesPerUsd();
  await svc.getVesPerUsd();

  assert.equal(calls, 1, 'the TTL suppresses repeat fetches');
});
