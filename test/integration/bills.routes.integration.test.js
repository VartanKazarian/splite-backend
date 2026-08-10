const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const bcv = require('../../src/connectors/bcv');
const fx = require('../../src/services/fx');
const { hashPassword } = require('../../src/services/auth');
const { caracasToday } = require('../../src/services/fx');
const app = require('../../src/app');

/**
 * The bill endpoints, over HTTP, against a real Postgres.
 *
 * The other integration suites call services directly, so a route could select
 * a column that no longer exists and every one of them would still pass. That
 * gap is what made "are the routes consistent with migration 008?" a question
 * answerable only by reading the code. These drive the actual HTTP surface.
 */
describe('bill routes over HTTP', { skip }, () => {
  const USD_RATE = 757.5406;
  const EUR_RATE = 875.2169568;

  let server;
  let base;
  let restaurant;
  let table;
  let token;
  let tableSeq = 0;
  const realFetchRates = bcv.fetchRates;

  const request = async (method, path, { body, auth = true, token: override } = {}) => {
    const bearer = override ?? token;
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(auth && bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const newTable = () => fixtures.createTable(restaurant.id, { name: `R${++tableSeq}` });

  /** A tenant of its own, priced in `currency`, with a token to act as it. */
  const extraTenants = [];
  const usdRestaurant = async (currency) => {
    const tenant = await fixtures.createRestaurant({ name: `${currency} Menu Tenant` });
    await db.query('UPDATE restaurants SET menu_currency = $1 WHERE id = $2', [currency, tenant.id]);

    const email = `${currency.toLowerCase()}-${tenant.id}@example.com`;
    const password = 'route-test-password-123';
    await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [tenant.id, email, await hashPassword(password)]
    );

    const login = await request('POST', '/api/v1/auth/login', { auth: false, body: { email, password } });
    assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);

    extraTenants.push(tenant.id);
    return { id: tenant.id, token: login.body.accessToken };
  };

  before(async () => {
    // A fixed rate, so the arithmetic below is deterministic rather than
    // dependent on what BCV publishes today.
    bcv.fetchRates = async () => ({
      rates: { USD: USD_RATE, EUR: EUR_RATE },
      valueDate: caracasToday()
    });
    fx.__reset();

    restaurant = await fixtures.createRestaurant({ name: 'Routes Tenant' });
    table = await newTable();

    const password = 'route-test-password-123';
    await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER')`,
      [restaurant.id, `routes-${restaurant.id}@example.com`, await hashPassword(password)]
    );

    server = app.listen(0);
    // unref'd so a failure in this hook cannot leave the listener holding the
    // event loop open: a hanging suite tells you far less than a failing one.
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const login = await request('POST', '/api/v1/auth/login', {
      auth: false,
      body: { email: `routes-${restaurant.id}@example.com`, password }
    });
    assert.equal(login.status, 200, `login failed: ${JSON.stringify(login.body)}`);
    token = login.body.accessToken;
  });

  after(async () => {
    bcv.fetchRates = realFetchRates;
    fx.__reset();
    if (server) await new Promise(resolve => server.close(resolve));
    for (const id of extraTenants) {
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [id]);
      await fixtures.destroyRestaurant(id);
    }
    if (restaurant) await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    // Login opens Redis through the rate limiter and the session mirror. Every
    // other integration suite is Postgres-only, so this is the first that has
    // to close it -- an open ioredis socket keeps the child process alive and
    // the runner waits on it forever.
    await closeRedis();
  });

  it('opens, reads and lists a VES bill', async () => {
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: table.id, totalDueMinorUnits: '10000' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // Every one of these fields comes from a column migration 008 introduced.
    assert.equal(created.body.currency, 'VES');
    assert.equal(created.body.total_due_ves, '10000');
    assert.equal(created.body.amount_paid_ves, '0');
    assert.equal(created.body.remaining_ves, '10000');
    assert.equal(Number(created.body.fx_rate_ves_per_unit), 1);
    assert.equal(created.body.fx_rate_source, 'IDENTITY');

    const read = await request('GET', `/api/v1/bills/${created.body.id}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.total_due_ves, '10000');

    const list = await request('GET', '/api/v1/bills?limit=5');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.data.some(b => b.id === created.body.id));
  });

  it('opens a bill on a USD menu and converts it to VES', async () => {
    // Its own restaurant rather than mutating the shared one: the first version
    // of this suite flipped menu_currency and reset it at the end, so when the
    // assertion in between failed the reset never ran and the next two tests
    // silently created foreign-currency bills.
    const usd = await usdRestaurant('USD');
    const usdTable = await fixtures.createTable(usd.id, { name: 'U1' });

    // $10.00 at 757.5406 is 757 540.6 céntimos, rounded half-up.
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: usdTable.id, totalDueMinorUnits: '1000' },
      token: usd.token
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    assert.equal(created.body.currency, 'USD', 'the bill inherits the menu currency');
    assert.equal(created.body.total_due, '1000', 'the menu-currency figure is kept for display');
    assert.equal(created.body.total_due_ves, '757541', 'settlement is VES, converted at the frozen rate');
    assert.equal(Number(created.body.fx_rate_ves_per_unit), USD_RATE);
    assert.equal(created.body.fx_rate_source, 'BCV');
    assert.equal(created.body.usdReference.totalDue, '10.00');
  });

  it('opens a bill on a EUR menu, at the precision BCV publishes', async () => {
    const eur = await usdRestaurant('EUR');
    const eurTable = await fixtures.createTable(eur.id, { name: 'E1' });

    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: eurTable.id, totalDueMinorUnits: '1000' },
      token: eur.token
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.currency, 'EUR');
    assert.equal(created.body.total_due_ves, '875217', '€10.00 at 875.2169568');

    // NUMERIC(20,8), so the stored rate is the published rate. At (20,6) this
    // came back as 875.216957 — near enough not to change a total, and still
    // not the number BCV printed.
    assert.equal(Number(created.body.fx_rate_ves_per_unit), EUR_RATE);
  });

  it('resolves a table to its open bill and quotes a split', async () => {
    const splitTable = await newTable();
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: splitTable.id, totalDueMinorUnits: '7567' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const open = await request('GET', `/api/v1/bills/tables/${splitTable.id}/open`);
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.equal(open.body.id, created.body.id);

    const split = await request('GET', `/api/v1/bills/${created.body.id}/split?diners=3`);
    assert.equal(split.status, 200, JSON.stringify(split.body));
    assert.deepEqual(split.body.shares, ['2523', '2522', '2522']);
    assert.equal(
      split.body.shares.reduce((sum, s) => sum + BigInt(s), 0n),
      7567n,
      'the shares sum to the outstanding total exactly'
    );
  });

  it('takes a payment and reflects it in the ledger and the bill', async () => {
    const payTable = await newTable();
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: payTable.id, totalDueMinorUnits: '5000' }
    });
    const billId = created.body.id;

    const paid = await request('POST', `/api/v1/bills/${billId}/payments`, {
      body: {
        billId,
        amountMinorUnits: 2000,
        currency: 'VES',
        idempotencyKey: `route-test-${billId}`
      }
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.amountPaid, '2000');
    assert.equal(paid.body.remaining, '3000');
    assert.ok(paid.body.paymentId, 'the response names the ledger row');

    const after = await request('GET', `/api/v1/bills/${billId}`);
    assert.equal(after.body.amount_paid_ves, '2000');
    assert.equal(after.body.remaining_ves, '3000');

    // The cache the route reads and the ledger must agree.
    const drift = await db.query('SELECT * FROM payment_ledger_drift WHERE bill_id = $1', [billId]);
    assert.equal(drift.rows.length, 0);
  });

  it('refuses a second open bill on the same table', async () => {
    const dupTable = await newTable();
    const first = await request('POST', '/api/v1/bills', {
      body: { tableId: dupTable.id, totalDueMinorUnits: '1000' }
    });
    assert.equal(first.status, 201);

    const second = await request('POST', '/api/v1/bills', {
      body: { tableId: dupTable.id, totalDueMinorUnits: '1000' }
    });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'OPEN_BILL_EXISTS');
    assert.equal(second.body.billId, first.body.id);
  });

  it('voids an unpaid bill and refuses one that has been paid into', async () => {
    const voidTable = await newTable();
    const unpaid = await request('POST', '/api/v1/bills', {
      body: { tableId: voidTable.id, totalDueMinorUnits: '1000' }
    });
    const voided = await request('POST', `/api/v1/bills/${unpaid.body.id}/void`);
    assert.equal(voided.status, 200, JSON.stringify(voided.body));
    assert.equal(voided.body.status, 'VOID');

    const paidTable = await newTable();
    const paidBill = await request('POST', '/api/v1/bills', {
      body: { tableId: paidTable.id, totalDueMinorUnits: '1000' }
    });
    await request('POST', `/api/v1/bills/${paidBill.body.id}/payments`, {
      body: {
        billId: paidBill.body.id,
        amountMinorUnits: 500,
        currency: 'VES',
        idempotencyKey: `route-void-${paidBill.body.id}`
      }
    });

    const refused = await request('POST', `/api/v1/bills/${paidBill.body.id}/void`);
    assert.equal(refused.status, 409, 'money has moved; reversing it is a refund');
  });

  it('reports every rate in force', async () => {
    const rates = await request('GET', '/api/v1/exchange-rate');
    assert.equal(rates.status, 200, JSON.stringify(rates.body));
    assert.equal(rates.body.rates.USD.rate, USD_RATE);
    assert.equal(rates.body.rates.EUR.rate, EUR_RATE);
  });

  it('scopes every read to the caller\'s restaurant', async () => {
    const other = await fixtures.createRestaurant({ name: 'Other Routes Tenant' });
    try {
      const otherTable = await fixtures.createTable(other.id);
      const otherBill = await fixtures.createBill({
        restaurantId: other.id, tableId: otherTable.id, totalDue: 1000
      });

      // Another tenant's bill is absent, not forbidden.
      assert.equal((await request('GET', `/api/v1/bills/${otherBill.id}`)).status, 404);
      assert.equal((await request('GET', `/api/v1/bills/${otherBill.id}/split?diners=2`)).status, 404);
      assert.equal((await request('POST', `/api/v1/bills/${otherBill.id}/void`)).status, 404);
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
