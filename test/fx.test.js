const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const bcv = require('../src/connectors/bcv');
const db = require('../src/connectors/base');
const config = require('../src/config');
const fx = require('../src/services/fx');

const realFetch = bcv.fetchRates;
const realQuery = db.query;
const realFxConfig = { ...config.fx };

/** Replaces the network with a scripted provider response. */
const provide = impl => { bcv.fetchRates = impl; };

beforeEach(() => {
  fx.__reset();
  // No database in the unit suite: the baseline load and the persist write are
  // both best-effort, so failing them is the realistic default here.
  db.query = async () => { throw new Error('no database in unit tests'); };
  Object.assign(config.fx, realFxConfig);
});

afterEach(() => {
  bcv.fetchRates = realFetch;
  db.query = realQuery;
  Object.assign(config.fx, realFxConfig);
  fx.__reset();
});

test('returns the rate from the provider', async () => {
  provide(async () => ({ rates: { USD: 757.5406 }, valueDate: '2026-08-10' }));

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
  provide(async () => ({ rates: { USD: 757.5406 }, valueDate: '2026-08-10' }));
  assert.equal((await fx.getUsdToVesRate()).rate, 757.5406);

  provide(async () => { throw new Error('upstream down'); });
  fx.__reset(); // expire the TTL

  assert.equal(await fx.getUsdToVesRate(), null, 'a stale rate is exactly what this must not serve');
});

test('rejects a rate outside the absolute bounds', async () => {
  provide(async () => ({ rates: { USD: 0.0001 }, valueDate: null }));
  assert.equal(await fx.getUsdToVesRate(), null);

  fx.__reset();
  provide(async () => ({ rates: { USD: 5e9 }, valueDate: null }));
  assert.equal(await fx.getUsdToVesRate(), null);
});

test('rejects a rate that jumps further than the deviation band allows', async () => {
  config.fx.maxDeviationPct = 5;
  // ttlMs 0 expires the cache on every call while leaving the deviation
  // baseline in place; __reset() would clear the baseline too and defeat the
  // point of the test.
  config.fx.ttlMs = 0;

  provide(async () => ({ rates: { USD: 700 }, valueDate: null }));
  assert.equal((await fx.getUsdToVesRate()).rate, 700, 'the first rate sets the baseline');

  // 700 -> 900 is ~28.6%. A page that changed shape looks exactly like this,
  // and silently repricing every menu is worse than showing no USD line.
  provide(async () => ({ rates: { USD: 900 }, valueDate: null }));
  assert.equal(await fx.getUsdToVesRate(), null, 'the jump is refused');

  // A move inside the band is still accepted, so the guard is not just "no".
  provide(async () => ({ rates: { USD: 720 }, valueDate: null }));
  assert.equal((await fx.getUsdToVesRate()).rate, 720);
});

test('accepts any rate when there is no baseline to compare against', async () => {
  provide(async () => ({ rates: { USD: 12345 }, valueDate: null }));
  const result = await fx.getUsdToVesRate();
  assert.equal(result.rate, 12345, 'a first-ever rate cannot deviate from anything');
});

test('a fresh cache is reused without calling the provider again', async () => {
  let calls = 0;
  provide(async () => { calls += 1; return { rates: { USD: 757.5406 }, valueDate: '2026-08-10' }; });

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
    return { rates: { USD: 757.5406 }, valueDate: '2026-08-10' };
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
  provide(async () => { called = true; return { rates: { USD: 757 }, valueDate: null }; });

  assert.equal(await fx.getUsdToVesRate(), null);
  assert.equal(called, false);
});

test('uses a publication whose value date has already arrived', async () => {
  const today = fx.caracasToday();
  provide(async () => ({ rates: { USD: 757.5406 }, valueDate: today }));

  const result = await fx.getUsdToVesRate();
  assert.equal(result.rate, 757.5406);
  assert.equal(result.valueDate, today);
});

test('does not price off a publication that is not in force yet', async () => {
  // BCV publishes around 16:30 Caracas for the next business day. Between then
  // and midnight the page shows tomorrow's rate; charging it today would apply
  // a rate that has not taken effect.
  provide(async () => ({ rates: { USD: 900 }, valueDate: '2999-01-01' }));
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
  provide(async () => ({ rates: { USD: 900 }, valueDate: '2999-01-01' }));
  db.query = async (sql) => {
    if (/INSERT INTO fx_rates/.test(sql)) return { rows: [] };
    return { rows: [] }; // nothing on record has taken effect
  };

  assert.equal(await fx.getUsdToVesRate(), null);
});

test('records the value date alongside the rate', async () => {
  const today = fx.caracasToday();
  let persisted = null;
  provide(async () => ({ rates: { USD: 757.5406 }, valueDate: today }));
  db.query = async (sql, params) => {
    if (/INSERT INTO fx_rates/.test(sql)) persisted = params;
    return { rows: [] };
  };

  await fx.getUsdToVesRate();
  assert.ok(persisted, 'the rate was written to fx_rates');
  // [source, base, rate, value_date]; quote is a literal 'VES' in the statement.
  assert.equal(persisted[1], 'USD', 'the rate is stored against its own currency');
  assert.equal(persisted[3], today, 'value_date is stored, not just fetched_at');
});

test('one fetch serves every currency the page publishes', async () => {
  // BCV publishes USD and EUR on the same page, so asking for both must not
  // cost two requests.
  let calls = 0;
  provide(async () => {
    calls += 1;
    return { rates: { USD: 757.5406, EUR: 875.2169568 }, valueDate: fx.caracasToday() };
  });

  const rates = await fx.getRates();
  assert.equal(calls, 1);
  assert.equal(rates.USD.rate, 757.5406);
  assert.equal(rates.EUR.rate, 875.2169568);
});

test('one currency failing its checks does not discard the others', async () => {
  // A page that changes shape can yield a plausible number for one block and
  // nonsense for another; the good one is still worth serving.
  provide(async () => ({ rates: { USD: 757.5406, EUR: 5e9 }, valueDate: fx.caracasToday() }));

  const rates = await fx.getRates();
  assert.equal(rates.USD.rate, 757.5406);
  assert.equal(rates.EUR, undefined, 'the out-of-bounds rate is dropped, not served');
});

test('VES needs no rate and never reaches the provider', async () => {
  let called = false;
  provide(async () => { called = true; return { rates: {}, valueDate: null }; });

  const ves = await fx.getRateFor('VES');
  assert.equal(ves.rate, 1);
  assert.equal(ves.source, 'IDENTITY');
  assert.equal(called, false);
});

/**
 * Falling back to the last in-force rate when BCV cannot be reached.
 *
 * The behaviour this replaces refused outright, which meant bcv.org.ve being
 * unreachable stopped a restaurant opening any foreign-currency bill. The rate
 * changes at most once per business day, so between publications the stored
 * figure is not a stale copy of the current rate -- it is the current rate.
 */

/** Answers the history query with a rate dated `daysAgo`, Caracas time. */
function historyDated(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 86400000);
  const valueDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);

  db.query = async sql => {
    if (/FROM fx_rates/.test(sql) && /value_date <=/.test(sql)) {
      // A Date, because that is what node-postgres hands back for a `date`
      // column. Handing back the ISO string instead is what hid a live bug:
      // the code did `String(value).slice(0, 10)`, which is "2026-09-05" for a
      // string and "Sat Sep 05" for a Date, and every guard downstream parses
      // that value. The double has to lie the same way the driver does.
      const [year, month, day] = valueDate.split('-').map(Number);
      return {
        rows: [{ rate: '757.54060000', source: 'BCV', value_date: new Date(year, month - 1, day) }]
      };
    }
    return { rows: [] };
  };
  return valueDate;
}

test('serves the last in-force rate when the provider is unreachable', async () => {
  const valueDate = historyDated(0);
  provide(async () => { throw new Error('bcv.org.ve unreachable'); });

  const rate = await fx.getRateFor('USD');
  assert.ok(rate, 'a reachable database holding today\'s rate must not produce an outage');
  assert.equal(rate.rate, 757.5406);
  assert.equal(rate.valueDate, valueDate);
  // Marked, because the bill snapshots the source and "how did we get this
  // number" is exactly the question that gets asked afterwards.
  assert.equal(rate.source, 'BCV_LAST_IN_FORCE');
});

test('refuses once the last rate is older than the fallback window', async () => {
  historyDated(config.fx.maxFallbackAgeDays + 1);
  provide(async () => { throw new Error('bcv.org.ve unreachable'); });

  // Past a publication cycle the figure really has stopped being true, and in
  // an economy that devalues, quietly pricing on it is worse than declining.
  assert.equal(await fx.getRateFor('USD'), null);
});

test('serves a rate exactly at the edge of the window', async () => {
  historyDated(config.fx.maxFallbackAgeDays);
  provide(async () => { throw new Error('bcv.org.ve unreachable'); });

  const rate = await fx.getRateFor('USD');
  assert.ok(rate, 'a long weekend must not be treated as an outage');
});

test('falls back when the deviation guard rejects the fetched rate', async () => {
  // The guard exists because a page that changes shape yields a plausible but
  // wrong number. Having rejected it, the last rate we trusted beats none.
  historyDated(0);
  provide(async () => ({ USD: { rate: 999999, source: 'BCV', valueDate: null } }));

  const rate = await fx.getRateFor('USD');
  assert.equal(rate?.source, 'BCV_LAST_IN_FORCE');
});

test('still returns nothing when there is no history to fall back on', async () => {
  db.query = async () => ({ rows: [] });
  provide(async () => { throw new Error('bcv.org.ve unreachable'); });

  assert.equal(await fx.getRateFor('USD'), null);
});

test('an unreachable database during fallback is not an exception', async () => {
  db.query = async () => { throw new Error('database down'); };
  provide(async () => { throw new Error('bcv.org.ve unreachable'); });

  // Both dependencies down is a real state, and it must produce "no rate"
  // rather than a 500 from the bill-opening route.
  assert.equal(await fx.getRateFor('USD'), null);
});
