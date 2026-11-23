const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const billing = require('../../src/services/platformBilling');
const platformMetrics = require('../../src/services/platformMetrics');

/**
 * What the console says about how a client uses Splite.
 *
 * Checked against rows this test put there: the figures are what somebody will
 * phone a restaurant about, so they have to be the restaurant's own numbers.
 */
describe('client usage and health in the console', { skip }, () => {
  let restaurant;
  let bill;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: `Health ${Date.now()}` });
    const table = await fixtures.createTable(restaurant.id, { name: 'S1' });
    bill = await fixtures.createBill({ restaurantId: restaurant.id, tableId: table.id, totalDue: 100000, totalDueVes: 100000 });
    await db.query('UPDATE bills SET fx_rate_ves_per_unit = 100 WHERE id = $1', [bill.id]);
    const pay = (amount, payer, status = 'SUCCEEDED', daysAgo = 1, method = 'CASH') => db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7))`,
      [restaurant.id, bill.id, amount, status, method, payer, daysAgo]
    );
    await pay(30000, 'GUEST', 'SUCCEEDED', 1, 'PAGO_MOVIL');
    await pay(10000, 'STAFF');
    await pay(5000, 'GUEST', 'FAILED', 2, 'C2P');
    await pay(90000, 'STAFF', 'SUCCEEDED', 45); // the previous window
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('lists 30-day volume, QR share and a score with reasons', async () => {
    const { data, summary } = await billing.listClients({ q: restaurant.name });
    const c = data.find(x => x.id === restaurant.id);
    assert.equal(c.activity30d.volumeVes, '40000');
    assert.equal(c.activity30d.volumeUsd, '400'); // 40000 céntimos at 100 Bs/$ = $4.00
    assert.equal(c.activity30d.previousVolumeVes, '90000');
    assert.equal(c.activity30d.payments, 2);
    assert.equal(c.activity30d.guestShareBps, 5000);
    assert.equal(c.activity30d.failedPayments, 1);
    // Less than half of the month before, and no menu or bank.
    assert.ok(c.health.reasons.includes('VOLUME_DROP_50'));
    assert.ok(c.health.reasons.includes('NO_MENU'));
    assert.ok(c.health.score < 100);
    assert.ok(Object.values(summary.byHealth).reduce((a, b) => a + b, 0) >= 1);
  });

  it('gives the file a daily series and the method mix', async () => {
    const detail = await billing.getClient(restaurant.id);
    assert.equal(detail.trend.daily.length, 30);
    const total = detail.trend.daily.reduce((s, d) => s + BigInt(d.volumeVes), 0n);
    assert.equal(total, 40000n);
    assert.deepEqual(detail.trend.methods.map(m => m.method), ['PAGO_MOVIL', 'CASH']);
    assert.equal(detail.trend.averageBillVes, '40000');
  });

  it('adds processing, funnel and aging to the summary', async () => {
    const s = await platformMetrics.summary();
    assert.ok(BigInt(s.processed30d.volumeUsd) >= 400n);
    assert.ok(s.funnel.signedUp >= 1 && s.funnel.firstQrPayment >= 1);
    assert.ok('days61PlusUsd' in s.aging);
    assert.equal(s.months.length, 6);
    assert.ok('processedUsd' in s.months[5]);
  });
});
