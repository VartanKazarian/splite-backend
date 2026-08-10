const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const bcv = require('../src/connectors/bcv');
const db = require('../src/connectors/base');
const config = require('../src/config');
const fx = require('../src/services/fx');

const realFetch = bcv.fetchUsdToVes;
const realQuery = db.query;
const realFxConfig = { ...config.fx };

/** Replaces the network with a scripted provider response. */
const provide = impl => { bcv.fetchUsdToVes = impl; };

beforeEach(() => {
  fx.__reset();
  // No database in the unit suite: the baseline load and the persist write are
  // both best-effort, so failing them is the realistic default here.
  db.query = async () => { throw new Error('no database in unit tests'); };
  Object.assign(config.fx, realFxConfig);
});

afterEach(() => {
  bcv.fetchUsdToVes = realFetch;
  db.query = realQuery;
  Object.assign(config.fx, realFxConfig);
  fx.__reset();
});

test('returns the rate from the provider', async () => {
  provide(async () => ({ rate: 757.5406, valueDate: '2026-08-10' }));

  const result = await fx.getUsdToVesRate();
  assert.equal(result.rate, 757.5406);
  assert.equal(result.valueDate, '2026-08-10');
  assert.equal(result.source, 'BCV');
});

test('returns null instead of guessing when the provider fails', async () => {
  provide(async () => { throw new Error('ENOTFOUND'); });

  // The whole point: a wrong rate is worse than a missing one, and there is no
  // fallback anywhere in the codebase.
  assert.equal(await fx.getUsdToVesRate(), null);
});

test('never serves a stale cached rate after a failure', async () => {
  provide(async () => ({ rate: 757.5406, valueDate: '2026-08-10' }));
  assert.equal((await fx.getUsdToVesRate()).rate, 757.5406);

  provide(async () => { throw new Error('upstream down'); });
  fx.__reset(); // expire the TTL

  assert.equal(await fx.getUsdToVesRate(), null, 'a stale rate is exactly what this must not serve');
});

test('rejects a rate outside the absolute bounds', async () => {
  provide(async () => ({ rate: 0.0001, valueDate: null }));
  assert.equal(await fx.getUsdToVesRate(), null);

  fx.__reset();
  provide(async () => ({ rate: 5e9, valueDate: null }));
  assert.equal(await fx.getUsdToVesRate(), null);
});

test('rejects a rate that jumps further than the deviation band allows', async () => {
  config.fx.maxDeviationPct = 5;
  // ttlMs 0 expires the cache on every call while leaving the deviation
  // baseline in place; __reset() would clear the baseline too and defeat the
  // point of the test.
  config.fx.ttlMs = 0;

  provide(async () => ({ rate: 700, valueDate: null }));
  assert.equal((await fx.getUsdToVesRate()).rate, 700, 'the first rate sets the baseline');

  // 700 -> 900 is ~28.6%. A page that changed shape looks exactly like this,
  // and silently repricing every menu is worse than showing no USD line.
  provide(async () => ({ rate: 900, valueDate: null }));
  assert.equal(await fx.getUsdToVesRate(), null, 'the jump is refused');

  // A move inside the band is still accepted, so the guard is not just "no".
  provide(async () => ({ rate: 720, valueDate: null }));
  assert.equal((await fx.getUsdToVesRate()).rate, 720);
});

test('accepts any rate when there is no baseline to compare against', async () => {
  provide(async () => ({ rate: 12345, valueDate: null }));
  const result = await fx.getUsdToVesRate();
  assert.equal(result.rate, 12345, 'a first-ever rate cannot deviate from anything');
});

test('a fresh cache is reused without calling the provider again', async () => {
  let calls = 0;
  provide(async () => { calls += 1; return { rate: 757.5406, valueDate: '2026-08-10' }; });

  await fx.getUsdToVesRate();
  await fx.getUsdToVesRate();
  await fx.getUsdToVesRate();

  assert.equal(calls, 1);
});

test('concurrent callers on a cold cache make a single upstream request', async () => {
  let calls = 0;
  provide(async () => {
    calls += 1;
    await new Promise(r => setTimeout(r, 10));
    return { rate: 757.5406, valueDate: '2026-08-10' };
  });

  const results = await Promise.all(Array.from({ length: 8 }, () => fx.getUsdToVesRate()));

  // The in-flight guard is assigned with no await before it, so eight callers
  // cannot each slip past the check and fire their own request.
  assert.equal(calls, 1);
  assert.equal(new Set(results.map(r => r.rate)).size, 1);
});

test('returns null when FX is disabled, without touching the provider', async () => {
  config.fx.enabled = false;
  let called = false;
  provide(async () => { called = true; return { rate: 757, valueDate: null }; });

  assert.equal(await fx.getUsdToVesRate(), null);
  assert.equal(called, false);
});

test('uses a publication whose value date has already arrived', async () => {
  const today = fx.caracasToday();
  provide(async () => ({ rate: 757.5406, valueDate: today }));

  const result = await fx.getUsdToVesRate();
  assert.equal(result.rate, 757.5406);
  assert.equal(result.valueDate, today);
});

test('does not price off a publication that is not in force yet', async () => {
  // BCV publishes around 16:30 Caracas for the next business day. Between then
  // and midnight the page shows tomorrow's rate; charging it today would apply
  // a rate that has not taken effect.
  provide(async () => ({ rate: 900, valueDate: '2999-01-01' }));
  db.query = async (sql) => {
    if (/INSERT INTO fx_rates/.test(sql)) return { rows: [] };
    if (/value_date <=/.test(sql)) {
      return { rows: [{ rate: '757.540600', source: 'BCV', value_date: '2026-08-09' }] };
    }
    return { rows: [] };
  };

  const result = await fx.getUsdToVesRate();
  assert.equal(result.rate, 757.5406, 'the rate in force is served, not the one published for tomorrow');
  assert.equal(result.valueDate, '2026-08-09');
});

test('returns null when the only known rate is not in force yet', async () => {
  provide(async () => ({ rate: 900, valueDate: '2999-01-01' }));
  db.query = async (sql) => {
    if (/INSERT INTO fx_rates/.test(sql)) return { rows: [] };
    return { rows: [] }; // nothing on record has taken effect
  };

  assert.equal(await fx.getUsdToVesRate(), null);
});

test('records the value date alongside the rate', async () => {
  const today = fx.caracasToday();
  let persisted = null;
  provide(async () => ({ rate: 757.5406, valueDate: today }));
  db.query = async (sql, params) => {
    if (/INSERT INTO fx_rates/.test(sql)) persisted = params;
    return { rows: [] };
  };

  await fx.getUsdToVesRate();
  assert.ok(persisted, 'the rate was written to fx_rates');
  assert.equal(persisted[4], today, 'value_date is stored, not just fetched_at');
});
