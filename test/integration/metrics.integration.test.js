process.env.METRICS_TOKEN = 'a-metrics-token-for-the-test-suite';
// The rest of the suite runs at LOG_LEVEL=silent to keep the output readable,
// and pino skips its hook for a line below the configured level -- so at silent
// nothing is logged and nothing is counted. Counting is the thing under test
// here, so this file needs a level that actually emits. Production refuses
// anything above `warn` for the same reason; see assertProductionConfig.
process.env.LOG_LEVEL = 'warn';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const metrics = require('../../src/services/metrics');

/**
 * The monitoring endpoint, end to end.
 *
 * Two halves worth proving against a real server: that the token actually gates
 * it -- this response names every queue in the installation and how far behind
 * each one is -- and that the queue gauges return the numbers a person would be
 * paged about, from real rows.
 */
describe('metrics', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  let seq = 0;

  const TOKEN = process.env.METRICS_TOKEN;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Metrics ${Date.now()}` });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  beforeEach(async () => {
    await db.query('DELETE FROM payment_transitions WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM payments WHERE restaurant_id = $1', [restaurant.id]);
  });

  const scrape = async (token = TOKEN) => {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    return { status: res.status, text: await res.text() };
  };

  const claim = async (status = 'PENDING', method = 'PAGO_MOVIL', ageMinutes = 0) => {
    const table = await fixtures.createTable(restaurant.id, { name: `M${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 10000, totalDueVes: 10000
    });
    await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type, created_at)
       VALUES ($1, $2, 5000, $3, $4, 'GUEST', NOW() - ($5 * INTERVAL '1 minute'))`,
      [restaurant.id, bill.id, status, method, ageMinutes]
    );
  };

  it('refuses without the token, and says nothing while refusing', async () => {
    const anonymous = await scrape(null);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.text.includes('splite_'), false, 'a refusal must not leak the numbers');

    const wrong = await scrape('not-the-token');
    assert.equal(wrong.status, 401);
  });

  it('serves the exposition format with the token', async () => {
    const res = await scrape();
    assert.equal(res.status, 200);
    assert.match(res.text, /^# (HELP|TYPE) /m);
  });

  it('counts the claims queue and how long the oldest has waited', async () => {
    // The pair the reconciler reports by hand. A count cannot tell a quiet
    // queue from an ignored one; the age is the half that pages somebody.
    await claim('PENDING', 'PAGO_MOVIL', 90);
    await claim('PENDING', 'PAGO_MOVIL', 5);

    const { text } = await scrape();
    const pending = /splite_pending_claims (\d+)/.exec(text);
    assert.ok(pending, text);
    assert.ok(Number(pending[1]) >= 2);

    const age = /splite_oldest_pending_claim_age_seconds (\d+)/.exec(text);
    assert.ok(age, 'the oldest claim has an age');
    assert.ok(Number(age[1]) >= 90 * 60, `expected at least 90 minutes, got ${age[1]}s`);
  });

  it('reports both unresolved C2P states, whatever their counts', async () => {
    // These gauges are deliberately cross-tenant -- this endpoint answers to
    // whoever runs the service -- which makes their values shared state that
    // other suites move under this one. So the assertions are the ones that
    // hold regardless of what else is running: a row this test created is
    // counted, and both series are present.
    //
    // The first version asserted AMBIGUOUS was exactly zero and passed alone.
    // Run beside the C2P suite, which creates ambiguous charges, it failed --
    // on main, because it was merged while the check was still in flight.
    //
    // Only additions and deletions of a suite's *own* rows happen concurrently,
    // so "at least the ones I made" is sound where an absolute count is not.
    await claim('IN_DOUBT', 'C2P');

    const { text } = await scrape();
    const inDoubt = /splite_unresolved_c2p\{status="IN_DOUBT"\} (\d+)/.exec(text);
    assert.ok(inDoubt, `IN_DOUBT series missing from:\n${text}`);
    assert.ok(Number(inDoubt[1]) >= 1, 'the charge this test created is counted');

    // Presence is the property that matters for the other one: a series which
    // vanishes at zero is a gap on a dashboard, and a gap reads as "no data"
    // rather than "nothing waiting". That it is emitted *at* zero is proved in
    // the unit suite, where the registry is not shared with anything.
    assert.match(text, /splite_unresolved_c2p\{status="AMBIGUOUS"\} \d+/);
  });

  it('counts a failure that was logged and swallowed', async () => {
    // The finding this closes. An audit write that fails is deliberately not
    // allowed to fail the business operation -- but nothing was watching, so a
    // silent hole in an append-only log was invisible.
    const { logAudit } = require('../../src/services/audit');
    metrics.reset();
    metrics.registerQueueGauges();

    await logAudit({
      action: 'METRICS_TEST',
      restaurantId: restaurant.id,
      // No such user, so the foreign key refuses and logAudit swallows it.
      actorId: '00000000-0000-4000-8000-0000000000ff'
    });

    const { text } = await scrape();
    assert.match(text, /splite_events_total\{event="AUDIT_WRITE_FAILED",level="error"\} \d+/);
  });
});
