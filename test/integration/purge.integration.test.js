const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const config = require('../../src/config');
const { purgeAll } = require('../../src/services/purge');

/**
 * Retention, against a real Postgres.
 *
 * The cases that matter are not "it deletes old rows" -- that is the easy half.
 * They are the ones where deleting the wrong row breaks something else: the FX
 * fallback that keeps bills openable when BCV is unreachable, and the event
 * record that stops a redelivered webhook settling a bill twice.
 */
describe('purge', { skip }, () => {
  const marker = `purge-test-${Date.now()}`;

  const ago = days => new Date(Date.now() - days * 86400000).toISOString();

  // A tenant of its own. The idempotency-key case below used to take whichever
  // restaurant `SELECT id FROM restaurants LIMIT 1` happened to return, which
  // is another suite's tenant: the integration files run in parallel, so that
  // suite's `after` hook could destroy it between the SELECT and the INSERT,
  // and the foreign key failed with 23503 on a test that had nothing to do
  // with it. Borrowing shared state across suites is the bug; owning a row is
  // the fix.
  let restaurant;

  before(async () => {
    await db.query("DELETE FROM fx_rates WHERE base = 'XTS'");
    restaurant = await fixtures.createRestaurant({ name: `Purge ${Date.now()}` });
  });

  beforeEach(async () => {
    await db.query("DELETE FROM fx_rates WHERE base = 'XTS'");
    await db.query('DELETE FROM webhook_events_processed WHERE provider = $1', [marker]);
    await db.query('DELETE FROM webhook_deliveries WHERE provider = $1', [marker]);
  });

  after(async () => {
    await db.query("DELETE FROM fx_rates WHERE base = 'XTS'");
    await db.query('DELETE FROM webhook_events_processed WHERE provider = $1', [marker]);
    await db.query('DELETE FROM webhook_deliveries WHERE provider = $1', [marker]);
    if (restaurant) await db.query('DELETE FROM idempotency_keys WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const insertRate = (daysOld, rate) => db.query(
    `INSERT INTO fx_rates (source, base, quote, rate, fetched_at, value_date)
     VALUES ('TEST', 'XTS', 'VES', $1, $2, $3::date)`,
    [rate, ago(daysOld), ago(daysOld).slice(0, 10)]
  );

  it('never deletes the newest rate for a currency, however old it is', async () => {
    // The trap: FX disabled or failing for longer than the retention window
    // means every row is older than it, and an age-based delete empties the
    // table -- turning the purge into the outage the fallback exists to
    // prevent. This rate is a year past retention and must survive.
    await insertRate(config.purge.fxRateDays + 365, '700.00000000');

    await purgeAll();

    const { rows } = await db.query("SELECT rate FROM fx_rates WHERE base = 'XTS'");
    assert.equal(rows.length, 1, 'the fallback must always have something to read');
  });

  it('deletes superseded rates but keeps the newest', async () => {
    await insertRate(config.purge.fxRateDays + 30, '700.00000000');
    await insertRate(config.purge.fxRateDays + 20, '710.00000000');
    await insertRate(1, '757.54060000');

    await purgeAll();

    const { rows } = await db.query(
      "SELECT rate::text FROM fx_rates WHERE base = 'XTS' ORDER BY value_date DESC"
    );
    assert.equal(rows.length, 1);
    assert.match(rows[0].rate, /^757\.5406/, 'the surviving row must be the current one');
  });

  it('keeps a webhook event record for longer than any provider retries', async () => {
    // Deleting one of these early is not losing history: it lets a late retry
    // be treated as a new event.
    await db.query(
      `INSERT INTO webhook_events_processed (provider, provider_event_id, outcome, processed_at)
       VALUES ($1, 'evt_recent', 'SETTLED', $2)`,
      [marker, ago(config.purge.webhookEventDays - 1)]
    );
    await db.query(
      `INSERT INTO webhook_events_processed (provider, provider_event_id, outcome, processed_at)
       VALUES ($1, 'evt_ancient', 'SETTLED', $2)`,
      [marker, ago(config.purge.webhookEventDays + 1)]
    );

    await purgeAll();

    const { rows } = await db.query(
      'SELECT provider_event_id FROM webhook_events_processed WHERE provider = $1', [marker]
    );
    assert.deepEqual(rows.map(r => r.provider_event_id), ['evt_recent']);
  });

  it('a dry run counts without deleting', async () => {
    await db.query(
      `INSERT INTO webhook_deliveries (provider, raw_body, outcome, received_at)
       VALUES ($1, '{}', 'SETTLED', $2)`,
      [marker, ago(config.purge.webhookDeliveryDays + 5)]
    );

    const { results } = await purgeAll({ dryRun: true });
    assert.ok(results.webhook_deliveries >= 1);

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM webhook_deliveries WHERE provider = $1', [marker]
    );
    assert.equal(rows[0].n, 1, 'a dry run must delete nothing');
  });

  it('removes expired idempotency keys and leaves live ones', async () => {
    const live = crypto.randomUUID();
    const dead = crypto.randomUUID();
    await db.query(
      `INSERT INTO idempotency_keys (restaurant_id, key, request_hash, expires_at)
       VALUES ($1, $2, repeat('a', 64), NOW() + INTERVAL '1 hour'),
              ($1, $3, repeat('b', 64), NOW() - INTERVAL '1 hour')`,
      [restaurant.id, live, dead]
    );

    await purgeAll();

    const { rows } = await db.query(
      'SELECT key FROM idempotency_keys WHERE key IN ($1, $2)', [live, dead]
    );
    assert.deepEqual(rows.map(x => x.key), [live]);
  });

  it('a second purge finds nothing to do rather than failing', async () => {
    await purgeAll();
    const { skipped } = await purgeAll();
    assert.equal(skipped, false, 'the advisory lock must be released between runs');
  });
});
