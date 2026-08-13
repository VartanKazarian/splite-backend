const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const bcv = require('../../src/connectors/bcv');
const fx = require('../../src/services/fx');
const { hashPassword } = require('../../src/services/auth');
const { signAccessToken } = require('../../src/utils/tokens');
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

  /**
   * A tenant of its own, priced in `currency`, with a token to act as it.
   *
   * The token is minted directly rather than obtained by logging in. /api/v1/auth
   * is limited to 10 requests a minute per IP, and every test here shares
   * 127.0.0.1 -- so a suite that logged in once per tenant started failing on
   * 429 as soon as it grew past ten. The limiter was right; the harness was
   * leaning on it. The real login path is still exercised once, in `before`.
   */
  const extraTenants = [];
  const usdRestaurant = async (currency) => {
    const tenant = await fixtures.createRestaurant({ name: `${currency} Menu Tenant` });
    await db.query('UPDATE restaurants SET menu_currency = $1 WHERE id = $2', [currency, tenant.id]);

    const email = `${currency.toLowerCase()}-${tenant.id}@example.com`;
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER') RETURNING id`,
      [tenant.id, email, await hashPassword('route-test-password-123')]
    );

    extraTenants.push(tenant.id);
    return {
      id: tenant.id,
      token: signAccessToken({ id: rows[0].id, restaurantId: tenant.id, role: 'OWNER' })
    };
  };


  /**
   * These suites drive real HTTP, so every request in them comes from
   * 127.0.0.1 against an app-level limit of 120 a minute. The limiter is
   * correct -- the harness is what shares one address across a hundred
   * requests -- so the buckets are cleared before each test rather than once
   * per suite, which stopped being enough as the suites grew.
   */
  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1',
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );

  beforeEach(clearIpRateLimits);

  before(async () => {
    // A fixed rate, so the arithmetic below is deterministic rather than
    // dependent on what BCV publishes today.
    bcv.fetchRates = async () => ({
      rates: { USD: USD_RATE, EUR: EUR_RATE },
      valueDate: caracasToday()
    });
    fx.__reset();

    // This is the only suite that drives HTTP, and every request in it comes
    // from 127.0.0.1 against an app-level limit of 120/minute per IP. A full run
    // spends most of that, so a second run inside the same minute starts at ~140
    // and fails on 429 that has nothing to do with the code under test. Clearing
    // the two IP-keyed buckets isolates the run from its own predecessor; the
    // per-user `bills:` buckets are keyed on fresh ids and need no help.
    await clearIpRateLimits();

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
    assert.equal(created.body.totalDueVes, '10000');
    assert.equal(created.body.amountPaidVes, '0');
    assert.equal(created.body.remainingVes, '10000');
    assert.equal(Number(created.body.fxRateVesPerUnit), 1);
    assert.equal(created.body.fxRateSource, 'IDENTITY');

    const read = await request('GET', `/api/v1/bills/${created.body.id}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.totalDueVes, '10000');

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
    assert.equal(created.body.totalDue, '1000', 'the menu-currency figure is kept for display');
    assert.equal(created.body.totalDueVes, '757541', 'settlement is VES, converted at the frozen rate');
    assert.equal(Number(created.body.fxRateVesPerUnit), USD_RATE);
    assert.equal(created.body.fxRateSource, 'BCV');
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
    assert.equal(created.body.totalDueVes, '875217', '€10.00 at 875.2169568');

    // NUMERIC(20,8), so the stored rate is the published rate. At (20,6) this
    // came back as 875.216957 — near enough not to change a total, and still
    // not the number BCV printed.
    assert.equal(Number(created.body.fxRateVesPerUnit), EUR_RATE);
  });

  it('states the BCV value date as a calendar date, with no zone attached', async () => {
    const tenant = await usdRestaurant('USD');
    const fxTable = await fixtures.createTable(tenant.id, { name: 'F1' });

    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: fxTable.id, totalDueMinorUnits: '1000' },
      token: tenant.token
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // node-pg turns a DATE column into a JS Date at *local* midnight, so the
    // default serialisation was "2025-03-06T04:00:00.000Z" on a Caracas host
    // and "...T00:00:00.000Z" on a UTC one -- the same row, two strings. A
    // client formatting that in its own zone can land a day early, and for a
    // BCV value date that is a different published rate.
    assert.match(created.body.fxValueDate, /^\d{4}-\d{2}-\d{2}$/,
      'a value date carries no time and no offset');
    assert.equal(created.body.fxValueDate, caracasToday());
  });

  it('speaks camelCase everywhere, on every bill-shaped response', async () => {
    // The void route used to return the raw row while the others went through
    // a presenter, so a voided bill came back in a different shape than the one
    // just read -- both documented as `Bill`.
    const camelTable = await newTable();
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: camelTable.id, totalDueMinorUnits: '4000' }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const read = await request('GET', `/api/v1/bills/${created.body.id}`);
    const open = await request('GET', `/api/v1/bills/tables/${camelTable.id}/open`);
    const list = await request('GET', `/api/v1/bills?tableId=${camelTable.id}`);
    const voided = await request('POST', `/api/v1/bills/${created.body.id}/void`);
    assert.equal(voided.status, 200, JSON.stringify(voided.body));

    const snake = body => Object.keys(body).filter(k => k.includes('_'));
    for (const [label, body] of [
      ['create', created.body], ['read', read.body], ['open', open.body],
      ['list item', list.body.data[0]], ['void', voided.body]
    ]) {
      assert.deepEqual(snake(body), [], `${label} leaks database column names`);
      assert.ok(body.totalDueVes !== undefined, `${label} is missing totalDueVes`);
      assert.ok(body.usdReference, `${label} is missing usdReference`);
    }

    // And the tables and menu surfaces, which had the same problem.
    const tables = await request('GET', '/api/v1/tables?limit=1');
    assert.deepEqual(snake(tables.body.data[0]), []);
    const settings = await request('GET', '/api/v1/menu/settings');
    assert.deepEqual(snake(settings.body), []);
    assert.ok(settings.body.menuCurrency, 'menu settings still name the currency');
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

    const split = await request('POST', `/api/v1/bills/${created.body.id}/split/preview`, {
      body: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
    });
    assert.equal(split.status, 200, JSON.stringify(split.body));
    assert.deepEqual(split.body.allocations.map(a => a.amountVes), ['2523', '2522', '2522']);
    assert.equal(
      split.body.allocations.reduce((sum, a) => sum + BigInt(a.amountVes), 0n),
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
    assert.equal(after.body.amountPaidVes, '2000');
    assert.equal(after.body.remainingVes, '3000');

    // The cache the route reads and the ledger must agree.
    const drift = await db.query('SELECT * FROM payment_ledger_drift WHERE bill_id = $1', [billId]);
    assert.equal(drift.rows.length, 0);
  });

  it('accepts a payment of 2^53 + 1 céntimos over HTTP', async () => {
    // The path this exercises is the one that was capped: HTTP string -> Joi
    // -> BigInt -> Postgres BIGINT, with no Number() in between.
    const total = '9007199254740993';
    const bigTable = await newTable();
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: bigTable.id, totalDueMinorUnits: total }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.totalDueVes, total);

    const paid = await request('POST', `/api/v1/bills/${created.body.id}/payments`, {
      body: {
        billId: created.body.id,
        amountMinorUnits: total,
        currency: 'VES',
        idempotencyKey: `big-${created.body.id}`
      }
    });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.amountPaid, total);
    assert.equal(paid.body.remaining, '0');
    assert.equal(paid.body.status, 'CLOSED');
  });

  it('refuses an amount that arrived as an already-rounded JSON number', async () => {
    const roundedTable = await newTable();
    const created = await request('POST', '/api/v1/bills', {
      body: { tableId: roundedTable.id, totalDueMinorUnits: '10000' }
    });

    const refused = await request('POST', `/api/v1/bills/${created.body.id}/payments`, {
      body: {
        billId: created.body.id,
        // A JSON number past 2^53: the client's parser already rounded it.
        amountMinorUnits: 9007199254740993,
        currency: 'VES',
        idempotencyKey: `rounded-${created.body.id}`
      }
    });
    assert.equal(refused.status, 400, 'banking a rounded figure is worse than refusing it');
  });

  it('resolves the exchange rate before opening a transaction', async () => {
    // The constraint: no external network call while a database transaction is
    // holding a business lock. This used to fetch from BCV *after* locking the
    // table row, so a slow upstream stalled every other request for that table,
    // held a pooled connection, and could leave the transaction idle long
    // enough for idle_in_transaction_session_timeout to terminate the session.
    const order = [];
    const realWithTransaction = db.withTransaction;
    const realFetch = bcv.fetchRates;

    fx.__reset();
    bcv.fetchRates = async () => {
      order.push('fx-start');
      await new Promise(r => setTimeout(r, 50));
      order.push('fx-end');
      return { rates: { USD: USD_RATE, EUR: EUR_RATE }, valueDate: caracasToday() };
    };
    db.withTransaction = (...args) => {
      order.push('tx-begin');
      return realWithTransaction(...args);
    };

    try {
      const usd = await usdRestaurant('USD');
      const usdTable = await fixtures.createTable(usd.id, { name: 'ORDER1' });
      order.length = 0; // ignore the setup's own queries

      const created = await request('POST', '/api/v1/bills', {
        body: { tableId: usdTable.id, totalDueMinorUnits: '1000' },
        token: usd.token
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    } finally {
      db.withTransaction = realWithTransaction;
      bcv.fetchRates = realFetch;
      fx.__reset();
    }

    assert.deepEqual(
      order,
      ['fx-start', 'fx-end', 'tx-begin'],
      'the rate must be resolved before BEGIN, never while holding the lock'
    );
  });

  it('opens a VES bill without any rate lookup at all', async () => {
    // A VES menu needs no conversion, so it must not reach the network even
    // once — the identity rate is recorded without asking BCV anything.
    let fetched = false;
    const realFetch = bcv.fetchRates;
    fx.__reset();
    bcv.fetchRates = async () => {
      fetched = true;
      return { rates: { USD: USD_RATE, EUR: EUR_RATE }, valueDate: caracasToday() };
    };

    try {
      const vesTable = await newTable();
      const created = await request('POST', '/api/v1/bills', {
        body: { tableId: vesTable.id, totalDueMinorUnits: '4200' }
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.fxRateSource, 'IDENTITY');
      assert.equal(fetched, false, 'a VES bill made no upstream call');
    } finally {
      bcv.fetchRates = realFetch;
      fx.__reset();
    }
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

    // The exact shape a client branches on: code identifies the case, and
    // details carries the bill to navigate to instead of parsing the message.
    assert.equal(second.body.error.code, 'OPEN_BILL_EXISTS');
    assert.equal(second.body.error.details.billId, first.body.id);
    assert.ok(second.body.error.requestId, 'a failure is correlatable with the logs');
    assert.equal(typeof second.body.error.message, 'string');
  });

  it('returns the same error envelope for every kind of failure', async () => {
    const envelope = body => {
      assert.ok(body.error, 'every failure nests under `error`');
      assert.equal(typeof body.error.code, 'string');
      assert.equal(typeof body.error.message, 'string');
      assert.equal(typeof body.error.details, 'object');
      assert.ok(body.error.details !== null, 'details is an object so `details.x` never throws');
      assert.ok(body.error.requestId, 'requestId is always present');
      return body.error;
    };

    // 400 validation -- used to be `{ error: [ ...strings ] }`.
    const invalid = await request('POST', '/api/v1/bills', { body: { tableId: 'nope' } });
    assert.equal(invalid.status, 400);
    assert.equal(envelope(invalid.body).code, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(invalid.body.error.details.fields), 'per-field messages live in details.fields');

    // 401 -- used to be `{ error: 'string' }` from middleware.
    const noAuth = await request('GET', '/api/v1/bills', { auth: false });
    assert.equal(noAuth.status, 401);
    assert.equal(envelope(noAuth.body).code, 'AUTH_TOKEN_MISSING');

    // 404 -- a named code, so the client knows which lookup failed.
    const missing = await request('GET', '/api/v1/bills/11111111-1111-4111-8111-111111111111');
    assert.equal(missing.status, 404);
    assert.equal(envelope(missing.body).code, 'BILL_NOT_FOUND');

    // 404 on an unrouted path, which came from a different handler entirely.
    const nowhere = await request('GET', '/api/v1/does-not-exist');
    assert.equal(nowhere.status, 404);
    assert.equal(envelope(nowhere.body).code, 'NOT_FOUND');

    // 400 from a body that contradicts the path.
    const mismatch = await request('POST', '/api/v1/bills/11111111-1111-4111-8111-111111111111/payments', {
      body: {
        billId: '22222222-2222-4222-8222-222222222222',
        amountMinorUnits: '100', currency: 'VES', idempotencyKey: 'k0123456789abcdef'
      }
    });
    assert.equal(mismatch.status, 400);
    assert.equal(envelope(mismatch.body).code, 'BILL_ID_MISMATCH');
  });

  it('refuses to overpay with a code and the balance still owed', async () => {
    const overTable = await newTable();
    const bill = await request('POST', '/api/v1/bills', {
      body: { tableId: overTable.id, totalDueMinorUnits: '5000' }
    });

    const over = await request('POST', `/api/v1/bills/${bill.body.id}/payments`, {
      body: {
        billId: bill.body.id, amountMinorUnits: '9000', currency: 'VES',
        idempotencyKey: `over-${bill.body.id}`
      }
    });

    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'PAYMENT_EXCEEDS_BALANCE');
    // Enough to re-render the amount due without a second round trip.
    assert.equal(over.body.error.details.remainingVes, '5000');
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
    assert.equal(rates.body.rates.USD.rate, '757.54060000');
    assert.equal(rates.body.rates.EUR.rate, '875.21695680');
    assert.equal(typeof rates.body.rates.USD.rate, 'string', 'rates cross the wire as strings');
  });

  it('identifies the caller without rotating anything', async () => {
    // The reason /auth/me exists. A client restoring a session must not have to
    // call /auth/refresh, because refresh rotates: two tabs booting at once
    // both present the same stored token, one claims it, and the other trips
    // reuse detection and revokes every session for that user.
    const me = await request('GET', '/api/v1/auth/me');
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.user.role, 'OWNER');
    assert.equal(me.body.user.restaurantId, restaurant.id);
    assert.ok(me.body.user.email);

    // Repeatable, unlike refresh: calling it twice changes nothing.
    const again = await request('GET', '/api/v1/auth/me');
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.user, me.body.user);

    // And no session was consumed doing it.
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM refresh_sessions WHERE user_id = $1 AND revoked_at IS NOT NULL',
      [me.body.user.id]
    );
    assert.equal(rows[0].n, 0, 'identifying yourself must not revoke a session');
  });

  it('refuses /auth/me without a staff token, and after deactivation', async () => {
    assert.equal((await request('GET', '/api/v1/auth/me', { auth: false })).status, 401);

    const tenant = await usdRestaurant('USD');
    const before = await request('GET', '/api/v1/auth/me', { token: tenant.token });
    assert.equal(before.status, 200);

    // Read from the database, not the token, so deactivation bites inside the
    // access token's fifteen minutes rather than at the end of them.
    await db.query('UPDATE users SET active = false WHERE restaurant_id = $1', [tenant.id]);
    const after = await request('GET', '/api/v1/auth/me', { token: tenant.token });
    assert.equal(after.status, 401, 'a deactivated account stops working immediately');
  });

  it('adds, updates and removes bill lines over HTTP', async () => {
    // Its own USD tenant, so the frozen rate and the menu currency are known.
    const tenant = await usdRestaurant('USD');
    const lineTable = await fixtures.createTable(tenant.id, { name: 'L1' });
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, 'Arepa', 1250, 'USD') RETURNING id`,
      [tenant.id]
    );
    const productId = rows[0].id;

    // Opened at zero: a bill with a fixed total is deliberately not itemisable.
    const bill = await request('POST', '/api/v1/bills', {
      body: { tableId: lineTable.id, totalDueMinorUnits: '0' },
      token: tenant.token
    });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));

    const added = await request('POST', `/api/v1/bills/${bill.body.id}/items`, {
      body: { productId, quantity: 2 }, token: tenant.token
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.item.name, 'Arepa', 'the snapshotted name, not a product lookup');
    assert.equal(added.body.item.unitPriceMinor, '1250');
    assert.equal(added.body.item.subtotalMinor, '2500');
    // $25.00 at 757.5406 is 1 893 851.5 céntimos, half-up.
    assert.equal(added.body.bill.totalDue, '2500');
    assert.equal(added.body.bill.totalDueVes, '1893852');

    // The single-bill read carries its lines; the list deliberately does not.
    const read = await request('GET', `/api/v1/bills/${bill.body.id}`, { token: tenant.token });
    assert.equal(read.body.itemCount, 1);
    assert.equal(read.body.items[0].id, added.body.item.id);
    assert.deepEqual(Object.keys(read.body.items[0]).filter(k => k.includes('_')), [],
      'lines speak camelCase like everything else');

    const list = await request('GET', '/api/v1/bills?limit=5', { token: tenant.token });
    assert.equal(list.body.data[0].items, undefined, 'the list stays cheap');

    const patched = await request('PATCH', `/api/v1/bills/${bill.body.id}/items/${added.body.item.id}`, {
      body: { quantity: 1 }, token: tenant.token
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.bill.totalDue, '1250');

    const removed = await request('DELETE', `/api/v1/bills/${bill.body.id}/items/${added.body.item.id}`, {
      token: tenant.token
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.bill.totalDue, '0');
  });

  it('reports line-item failures in the standard envelope', async () => {
    const tenant = await usdRestaurant('USD');
    const errTable = await fixtures.createTable(tenant.id, { name: 'L2' });

    // A bill opened with a fixed total cannot be itemised.
    const fixed = await request('POST', '/api/v1/bills', {
      body: { tableId: errTable.id, totalDueMinorUnits: '5000' }, token: tenant.token
    });
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, 'Cachapa', 900, 'USD') RETURNING id`,
      [tenant.id]
    );

    const refused = await request('POST', `/api/v1/bills/${fixed.body.id}/items`, {
      body: { productId: rows[0].id }, token: tenant.token
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'BILL_NOT_ITEMISED');
    assert.equal(refused.body.error.details.totalDue, '5000');
    assert.ok(refused.body.error.requestId);

    // An unknown line on a real bill is a 404 naming what was not found.
    const missing = await request('DELETE',
      `/api/v1/bills/${fixed.body.id}/items/11111111-1111-4111-8111-111111111111`,
      { token: tenant.token });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'BILL_ITEM_NOT_FOUND');
  });

  it('splits a real itemised bill four ways over HTTP', async () => {
    const tenant = await usdRestaurant('USD');
    const splitTable = await fixtures.createTable(tenant.id, { name: 'S9' });
    const menu = async (name, price) => (await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, $2, $3, 'USD') RETURNING id`, [tenant.id, name, price]
    )).rows[0].id;

    const burger = await menu('Split Burger', 2500);
    const wine = await menu('Split Wine', 3000);

    const bill = await request('POST', '/api/v1/bills', {
      body: { tableId: splitTable.id, totalDueMinorUnits: '0' }, token: tenant.token
    });
    const addBurger = await request('POST', `/api/v1/bills/${bill.body.id}/items`, {
      body: { productId: burger, quantity: 1 }, token: tenant.token
    });
    const addWine = await request('POST', `/api/v1/bills/${bill.body.id}/items`, {
      body: { productId: wine, quantity: 1 }, token: tenant.token
    });
    // $55.00 at 757.5406 -> 4 166 473 céntimos.
    const outstanding = addWine.body.bill.totalDueVes;
    assert.equal(outstanding, '4166473');

    const preview = (body) =>
      request('POST', `/api/v1/bills/${bill.body.id}/split/preview`, { body, token: tenant.token });

    const exact = res => {
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const summed = res.body.allocations.reduce((t, a) => t + BigInt(a.amountVes), 0n);
      assert.equal(summed.toString(), res.body.outstandingVes, 'allocations must sum to the balance');
      assert.equal(res.body.totalAllocatedVes, res.body.outstandingVes);
      assert.equal(res.body.outstandingVes, outstanding, 'every mode divides the same figure');
      return res.body;
    };

    exact(await preview({ mode: 'FULL', participants: [{ id: 'ana', name: 'Ana' }] }));

    // 4 166 473 across 3 does not divide cleanly, which is the interesting case.
    const equal = exact(await preview({
      mode: 'EQUAL', participants: [{ id: 'ana' }, { id: 'bea' }, { id: 'cid' }]
    }));
    assert.deepEqual(equal.allocations.map(a => a.amountVes), ['1388825', '1388824', '1388824']);

    // Ana takes the burger, the wine is shared.
    const byItems = exact(await preview({
      mode: 'ITEMS',
      participants: [{ id: 'ana' }, { id: 'bea' }],
      claims: [
        { itemId: addBurger.body.item.id, participantIds: ['ana'] },
        { itemId: addWine.body.item.id, participantIds: ['ana', 'bea'] }
      ]
    }));
    // Ana owes the burger plus half the wine; Bea owes half the wine.
    assert.ok(BigInt(byItems.allocations[0].amountVes) > BigInt(byItems.allocations[1].amountVes));

    exact(await preview({
      mode: 'CUSTOM',
      participants: [{ id: 'ana', amountVes: '166473' }, { id: 'bea', amountVes: '4000000' }]
    }));

    // And a split that does not add up is refused in the standard envelope.
    const wrong = await preview({
      mode: 'CUSTOM', participants: [{ id: 'ana', amountVes: '1' }]
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'SPLIT_AMOUNT_MISMATCH');
    assert.equal(wrong.body.error.details.outstandingVes, outstanding);
  });

  it('a split preview moves no money', async () => {
    const tenant = await usdRestaurant('USD');
    const t = await fixtures.createTable(tenant.id, { name: 'S10' });
    const bill = await fixtures.createBill({
      restaurantId: tenant.id, tableId: t.id, totalDue: 1000,
      currency: 'USD', totalDueVes: 757541, fxRate: '757.54060000'
    });

    const before = await fixtures.readBill(bill.id);
    const res = await request('POST', `/api/v1/bills/${bill.id}/split/preview`, {
      body: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }, token: tenant.token
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const after = await fixtures.readBill(bill.id);
    // Advisory means advisory: the endpoint reads and returns, nothing else.
    assert.deepEqual(after, before, 'the bill is untouched by a preview');
  });

  it('creates the tables a restaurant says it has, idempotently', async () => {
    const tenant = await usdRestaurant('USD');

    const first = await request('POST', '/api/v1/tables/bulk', {
      body: { count: 4, prefix: 'Salon' }, token: tenant.token
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.created, 4);
    assert.deepEqual(first.body.data.map(t => t.name), ['Salon 1', 'Salon 2', 'Salon 3', 'Salon 4']);

    // Running it again creates nothing rather than failing.
    const again = await request('POST', '/api/v1/tables/bulk', {
      body: { count: 4, prefix: 'Salon' }, token: tenant.token
    });
    assert.equal(again.body.created, 0);
    assert.equal(again.body.alreadyExisted, 4);
    assert.equal(again.body.data.length, 4, 'still four tables, not eight');

    // Raising the count adds only the new ones.
    const more = await request('POST', '/api/v1/tables/bulk', {
      body: { count: 6, prefix: 'Salon' }, token: tenant.token
    });
    assert.equal(more.body.created, 2);
    assert.equal(more.body.data.length, 6);

    // Lowering it destroys nothing.
    const fewer = await request('POST', '/api/v1/tables/bulk', {
      body: { count: 2, prefix: 'Salon' }, token: tenant.token
    });
    assert.equal(fewer.body.created, 0);
    assert.equal(fewer.body.data.length, 6, 'a smaller number must never delete tables');
  });

  it('renders the whole floor in one call, with bills attached', async () => {
    const tenant = await usdRestaurant('USD');
    await request('POST', '/api/v1/tables/bulk', { body: { count: 3, prefix: 'F' }, token: tenant.token });

    const tables = await request('GET', '/api/v1/tables', { token: tenant.token });
    const target = tables.body.data.find(t => t.name === 'F 2');

    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, 'Floor Dish', 2000, 'USD') RETURNING id`, [tenant.id]
    );
    const bill = await request('POST', '/api/v1/bills', {
      body: { tableId: target.id, totalDueMinorUnits: '0' }, token: tenant.token
    });
    await request('POST', `/api/v1/bills/${bill.body.id}/items`, {
      body: { productId: rows[0].id, quantity: 2 }, token: tenant.token
    });

    const floor = await request('GET', '/api/v1/tables/floor', { token: tenant.token });
    assert.equal(floor.status, 200, JSON.stringify(floor.body));
    assert.equal(floor.body.data.length, 3);

    const busy = floor.body.data.find(t => t.name === 'F 2');
    const free = floor.body.data.find(t => t.name === 'F 1');

    assert.equal(busy.openBill.id, bill.body.id);
    assert.equal(busy.openBill.itemCount, 1);
    assert.equal(busy.openBill.totalDue, '4000');
    assert.equal(busy.openBill.remainingVes, busy.openBill.totalDueVes);

    // Null, not absent: the shape must not change with occupancy.
    assert.equal(free.openBill, null);
    assert.ok('openBill' in free, 'a free table still carries the key');

    // Closing the bill frees the table again.
    await request('POST', `/api/v1/bills/${bill.body.id}/void`, { token: tenant.token });
    const after = await request('GET', '/api/v1/tables/floor', { token: tenant.token });
    assert.equal(after.body.data.find(t => t.name === 'F 2').openBill, null);
  });

  it('the floor shows only the caller\'s own tables', async () => {
    const mine = await usdRestaurant('USD');
    const theirs = await usdRestaurant('USD');
    await request('POST', '/api/v1/tables/bulk', { body: { count: 2, prefix: 'Mine' }, token: mine.token });
    await request('POST', '/api/v1/tables/bulk', { body: { count: 2, prefix: 'Theirs' }, token: theirs.token });

    const floor = await request('GET', '/api/v1/tables/floor', { token: mine.token });
    assert.deepEqual(floor.body.data.map(t => t.name).sort(), ['Mine 1', 'Mine 2']);
  });

  it('bulk table creation is refused to a waiter', async () => {
    const tenant = await usdRestaurant('USD');
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'WAITER') RETURNING id`,
      [tenant.id, `waiter-${tenant.id}@example.com`, await hashPassword('irrelevant-for-this-test')]
    );
    const waiterToken = signAccessToken({ id: rows[0].id, restaurantId: tenant.id, role: 'WAITER' });

    const res = await request('POST', '/api/v1/tables/bulk', {
      body: { count: 3 }, token: waiterToken
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('takes an order for a table, opening the bill on the first one', async () => {
    const tenant = await usdRestaurant('USD');
    await request('POST', '/api/v1/tables/bulk', { body: { count: 1, prefix: 'Ord' }, token: tenant.token });
    const t = (await request('GET', '/api/v1/tables', { token: tenant.token })).body.data
      .find(x => x.name === 'Ord 1');

    const menu = async (name, price) => (await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, $2, $3, 'USD') RETURNING id`, [tenant.id, name, price]
    )).rows[0].id;
    const beer = await menu('Beer', 300);
    const burger = await menu('Burger', 1250);

    // No bill yet: the order opens one.
    const first = await request('POST', `/api/v1/bills/tables/${t.id}/order`, {
      body: { items: [{ productId: beer, quantity: 2 }, { productId: burger, quantity: 1 }] },
      token: tenant.token
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.opened, true, 'this order opened the bill');
    assert.equal(first.body.bill.itemCount, 2);
    assert.equal(first.body.bill.subtotalMinor, '1850', '2 x 300 + 1250');

    // A second order joins the same bill rather than opening another.
    const second = await request('POST', `/api/v1/bills/tables/${t.id}/order`, {
      body: { items: [{ productId: beer, quantity: 1 }] }, token: tenant.token
    });
    assert.equal(second.body.opened, false, 'the table already had a bill');
    assert.equal(second.body.bill.id, first.body.bill.id);
    assert.equal(second.body.bill.itemCount, 3);
    assert.equal(second.body.bill.subtotalMinor, '2150');

    // And the floor shows it.
    const floor = await request('GET', '/api/v1/tables/floor', { token: tenant.token });
    assert.equal(floor.body.data.find(x => x.name === 'Ord 1').openBill.itemCount, 3);
  });

  it('a bad line rolls back the whole order', async () => {
    const tenant = await usdRestaurant('USD');
    await request('POST', '/api/v1/tables/bulk', { body: { count: 1, prefix: 'Roll' }, token: tenant.token });
    const t = (await request('GET', '/api/v1/tables', { token: tenant.token })).body.data
      .find(x => x.name === 'Roll 1');
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, 'Real', 500, 'USD') RETURNING id`, [tenant.id]
    );

    // Second line names a product that does not exist. Neither line may land,
    // and no empty bill may be left behind.
    const res = await request('POST', `/api/v1/bills/tables/${t.id}/order`, {
      body: {
        items: [
          { productId: rows[0].id, quantity: 1 },
          { productId: '11111111-1111-4111-8111-111111111111', quantity: 1 }
        ]
      },
      token: tenant.token
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'PRODUCT_NOT_FOUND');

    const open = await request('GET', `/api/v1/bills/tables/${t.id}/open`, { token: tenant.token });
    assert.equal(open.status, 404, 'the failed order left no bill behind');
    assert.equal(open.body.error.code, 'OPEN_BILL_NOT_FOUND');
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
      assert.equal((await request('POST', `/api/v1/bills/${otherBill.id}/split/preview`, {
        body: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }] }
      })).status, 404);
      assert.equal((await request('POST', `/api/v1/bills/${otherBill.id}/void`)).status, 404);
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
