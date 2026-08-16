const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const config = require('../../src/config');
const { recordPayment } = require('../../src/services/payments');

/**
 * Webhook delivery semantics, against a real Postgres.
 *
 * The signature rules are unit-tested; what has never been exercised is what
 * happens *after* a delivery is authenticated. Every case here is a way a
 * provider actually behaves rather than a way one might: they retry on any
 * non-2xx, they retry on timeouts where we in fact succeeded, they occasionally
 * deliver the same event twice at once, and they call back fast enough to
 * overtake our own commit.
 */
describe('webhook delivery', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  let table;
  let seq = 0;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Webhook Test ${Date.now()}` });
    table = await fixtures.createTable(restaurant.id, { name: 'W1' });
  });

  beforeEach(async () => {
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1',
      'webhook:::ffff:127.0.0.1', 'webhook:127.0.0.1');
    // The signature replay key is per-signature; each test signs its own body,
    // but a repeated body inside one test would otherwise collide.
    const seen = await redis.keys('webhook:seen:*');
    if (seen.length) await redis.del(...seen);
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.query('DELETE FROM webhook_events_processed WHERE provider = $1', ['SPLITE']);
    await db.query("DELETE FROM webhook_deliveries WHERE provider = 'SPLITE'");
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  /** A bill with a PENDING payment sitting on it, the way a provider flow starts. */
  async function pendingPayment({ totalDue = 10000, amount = 10000 } = {}) {
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue
    });
    const payment = await db.withTransaction(client => recordPayment(client, {
      restaurantId: restaurant.id,
      billId: bill.id,
      amountVes: BigInt(amount),
      status: 'PENDING',
      paymentMethod: 'CARD',
      provider: 'SPLITE',
      payerType: 'GUEST'
    }));
    return { bill, payment };
  }

  const deliver = async (body, { timestamp = Math.floor(Date.now() / 1000) } = {}) => {
    const raw = JSON.stringify(body);
    const signature = crypto
      .createHmac('sha256', config.webhookSecret)
      .update(`${timestamp}.${raw}`)
      .digest('hex');

    const res = await fetch(`${baseUrl}/api/v1/webhooks/SPLITE`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': String(timestamp)
      },
      body: raw
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };

  const succeededEvent = (payment, eventId) => ({
    eventId: eventId || `evt_${++seq}_${Date.now()}`,
    id: `prov_${seq}`,
    status: 'SUCCEEDED',
    metadata: { splitePaymentId: payment.id, restaurantId: restaurant.id }
  });

  const billOf = async id => (await db.query(
    'SELECT status, amount_paid_ves FROM bills WHERE id = $1', [id]
  )).rows[0];

  it('settles the bill, taking the amount from our record', async () => {
    const { bill, payment } = await pendingPayment({ totalDue: 10000, amount: 10000 });

    const res = await deliver({
      ...succeededEvent(payment),
      // A figure the provider claims. It must be ignored: a valid signature
      // proves who sent the delivery, not what is owed.
      amountVes: '999999999'
    });

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body, { received: true, settled: true, reason: 'SETTLED' });

    const after = await billOf(bill.id);
    assert.equal(after.amount_paid_ves, '10000', 'the body must not be able to set the amount');
    assert.equal(after.status, 'CLOSED');
  });

  it('answers a redelivery 2xx and settles nothing twice', async () => {
    const { bill, payment } = await pendingPayment();
    const event = succeededEvent(payment);

    const first = await deliver(event);
    assert.equal(first.status, 202);
    assert.equal(first.body.settled, true);

    // Same event id, re-signed with a fresh timestamp -- which is what a
    // provider retry actually looks like, and why the Redis key on the
    // signature never caught one.
    const retry = await deliver(event, { timestamp: Math.floor(Date.now() / 1000) + 1 });
    assert.equal(retry.status, 202, 'a duplicate answered non-2xx retries forever');
    assert.deepEqual(retry.body, { received: true, settled: false, reason: 'DUPLICATE' });

    const after = await billOf(bill.id);
    assert.equal(after.amount_paid_ves, '10000', 'paid exactly once');
  });

  it('two simultaneous deliveries of one event settle it once', async () => {
    const { bill, payment } = await pendingPayment();
    const event = succeededEvent(payment);

    const [a, b] = await Promise.all([
      deliver(event, { timestamp: Math.floor(Date.now() / 1000) }),
      deliver(event, { timestamp: Math.floor(Date.now() / 1000) + 1 })
    ]);

    const outcomes = [a, b].map(r => r.body.reason).sort();
    assert.deepEqual(outcomes, ['DUPLICATE', 'SETTLED'], `got ${JSON.stringify([a.body, b.body])}`);
    assert.ok([a.status, b.status].every(s => s === 202));

    const after = await billOf(bill.id);
    assert.equal(after.amount_paid_ves, '10000');

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM webhook_events_processed WHERE provider_event_id = $1',
      [event.eventId]
    );
    assert.equal(rows[0].n, 1, 'one row per event, whatever the concurrency');
  });

  it('asks the provider to retry when the payment is not visible yet', async () => {
    // The race this exists for: a callback overtaking the commit of our own
    // PENDING row. Answering 202 here loses a real settlement permanently --
    // the money has moved and the bill never closes.
    const res = await deliver({
      eventId: `evt_missing_${Date.now()}`,
      status: 'SUCCEEDED',
      metadata: {
        splitePaymentId: '00000000-0000-4000-8000-000000000000',
        restaurantId: restaurant.id
      }
    });

    assert.equal(res.status, 503, 'must be non-2xx so the provider retries');
    assert.equal(res.body.error.code, 'WEBHOOK_PAYMENT_UNRESOLVED');
    assert.ok(res.headers.get('retry-after'), 'providers key their backoff off this');
  });

  it('leaves a failed delivery retryable rather than claiming its event', async () => {
    // The trap in claim-first idempotency: a claim that survives a failure
    // blocks the very retry that was supposed to fix it.
    const eventId = `evt_retry_${Date.now()}`;
    const missing = {
      eventId, status: 'SUCCEEDED',
      metadata: {
        splitePaymentId: '00000000-0000-4000-8000-000000000000',
        restaurantId: restaurant.id
      }
    };

    assert.equal((await deliver(missing)).status, 503);

    const claimed = await db.query(
      'SELECT 1 FROM webhook_events_processed WHERE provider_event_id = $1', [eventId]
    );
    assert.equal(claimed.rows.length, 0, 'a failed attempt must claim nothing');

    // And now the payment exists, exactly as it would a moment later.
    const { bill, payment } = await pendingPayment();
    const res = await deliver({
      eventId, status: 'SUCCEEDED',
      metadata: { splitePaymentId: payment.id, restaurantId: restaurant.id }
    });

    assert.equal(res.status, 202);
    assert.equal(res.body.settled, true, 'the retry must be able to succeed');
    assert.equal((await billOf(bill.id)).status, 'CLOSED');
  });

  it('records every attempt, including the ones it refused', async () => {
    const eventId = `evt_evidence_${Date.now()}`;
    await deliver({
      eventId, status: 'SUCCEEDED',
      metadata: {
        splitePaymentId: '00000000-0000-4000-8000-000000000000',
        restaurantId: restaurant.id
      }
    });

    const { rows } = await db.query(
      'SELECT outcome, raw_body FROM webhook_deliveries WHERE provider_event_id = $1', [eventId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'PAYMENT_UNRESOLVED');
    assert.ok(rows[0].raw_body.includes(eventId), 'the bytes as received, for evidence');
  });

  it('ignores a failure that arrives after the payment already succeeded', async () => {
    const { bill, payment } = await pendingPayment();
    await deliver(succeededEvent(payment));

    const late = await deliver({
      eventId: `evt_late_${Date.now()}`,
      status: 'FAILED',
      metadata: { splitePaymentId: payment.id, restaurantId: restaurant.id }
    });

    assert.equal(late.status, 202);
    assert.equal(late.body.reason, 'DUPLICATE');

    const after = await billOf(bill.id);
    assert.equal(after.status, 'CLOSED', 'a late FAILED must not reopen a settled bill');
    assert.equal(after.amount_paid_ves, '10000');
  });

  it('accepts an unattributable body once and does not ask for it again', async () => {
    // The opposite of the unresolved case: this body never named a payment and
    // will not grow one however many times it is resent, so retrying is pure
    // noise. It is kept for somebody to read.
    const res = await deliver({ eventId: `evt_blank_${Date.now()}`, status: 'SUCCEEDED' });
    assert.equal(res.status, 202);
    assert.equal(res.body.reason, 'UNATTRIBUTED');
  });

  it('refuses a tampered body and records the attempt', async () => {
    const raw = JSON.stringify({ eventId: 'evt_tamper', status: 'SUCCEEDED' });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto.createHmac('sha256', config.webhookSecret)
      .update(`${timestamp}.${raw}`).digest('hex');

    const res = await fetch(`${baseUrl}/api/v1/webhooks/SPLITE`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-webhook-signature': signature,
        'x-webhook-timestamp': String(timestamp)
      },
      body: raw.replace('SUCCEEDED', 'FAILED')
    });

    assert.equal(res.status, 401);
    const { rows } = await db.query(
      "SELECT outcome FROM webhook_deliveries WHERE outcome = 'SIGNATURE_INVALID' ORDER BY received_at DESC LIMIT 1"
    );
    assert.equal(rows[0]?.outcome, 'SIGNATURE_INVALID');
  });

  it('has no adapter for an unknown provider', async () => {
    const res = await fetch(`${baseUrl}/api/v1/webhooks/NOTAPROVIDER`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'WEBHOOK_PROVIDER_UNKNOWN');
  });
});
