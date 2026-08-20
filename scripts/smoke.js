#!/usr/bin/env node
'use strict';

/**
 * Post-deploy smoke test: drives the whole product path against a running
 * instance and asserts the things that only break in production.
 *
 *   SMOKE_URL=https://your-api SMOKE_EMAIL=you@example.com \
 *   SMOKE_PASSWORD='…' npm run smoke
 *
 * Deliberately reads credentials from the environment and never prints a
 * token, so the output is safe to paste into an issue or a chat.
 *
 * It writes: one table, one product, one bill with a line on it. Nothing here
 * hard-deletes, so it leaves a deactivated table, a deactivated product and a
 * voided bill behind, all named `smoke-<timestamp>`.
 */

const BASE = (process.env.SMOKE_URL || '').replace(/\/$/, '');
const EMAIL = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;
const ORIGIN = process.env.SMOKE_ORIGIN; // optional: check CORS for a frontend

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('SMOKE_URL, SMOKE_EMAIL and SMOKE_PASSWORD are required.');
  process.exit(2);
}

const tag = `smoke-${Date.now()}`;
let token = null;
let passed = 0;
let failed = 0;

const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  ok ? passed++ : failed++;
  return ok;
};

async function call(method, path, { body, auth = true, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed };
}

/** Describes a failure without echoing anything sensitive. */
const why = res => res.body?.error?.code || `HTTP ${res.status}`;

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  console.log('health');
  const ready = await call('GET', '/health/ready', { auth: false });
  check('dependencies reachable', ready.status === 200 && ready.body.postgres === 'up' && ready.body.redis === 'up',
    JSON.stringify(ready.body));

  console.log('\nauthentication');
  const login = await call('POST', '/api/v1/auth/login', { auth: false, body: { email: EMAIL, password: PASSWORD } });
  if (!check('login', login.status === 200, why(login))) {
    // The API returns the same error for an unknown email and a wrong
    // password, deliberately, so that it cannot be used to enumerate accounts.
    // That is right for the API and unhelpful here, where the overwhelmingly
    // common cause is that a fresh deployment was never seeded -- migrations
    // create the schema, not an owner.
    if (login.body?.error?.code === 'INVALID_CREDENTIALS') {
      console.log([
        '',
        '  The API cannot say whether the email is unknown or the password is wrong;',
        '  it answers identically either way so accounts cannot be enumerated.',
        '',
        '  On a fresh deployment the usual cause is that no owner exists yet.',
        '  Check the users table, and if it is empty:',
        '',
        '    ALLOW_PRODUCTION_SEED=true SEED_OWNER_EMAIL=… SEED_OWNER_PASSWORD=… npm run seed',
        '',
        '  The seed is idempotent: re-running it resets that owner\'s password',
        '  rather than creating a second restaurant.'
      ].join('\n'));
    }
    console.log('\nCannot continue without a session.\n');
    process.exit(1);
  }
  token = login.body.accessToken;

  const me = await call('GET', '/api/v1/auth/me');
  check('/auth/me identifies the caller', me.status === 200 && Boolean(me.body.user?.restaurantId), why(me));
  check('/auth/me is repeatable', (await call('GET', '/api/v1/auth/me')).status === 200);

  console.log('\nexchange rate');
  const fx = await call('GET', '/api/v1/exchange-rate');
  if (fx.status === 200) {
    const usd = fx.body.rates?.USD;
    check('BCV reachable, USD published', Boolean(usd), usd ? `${usd.rate} valueDate ${usd.valueDate}` : '');
    check('rate is a padded string, not a number', typeof usd?.rate === 'string' && /^\d+\.\d{8}$/.test(usd.rate),
      String(usd?.rate));
  } else {
    // Deliberately not called "BCV unreachable": the commonest cause is not a
    // network failure at all. BCV publishes around 16:30 Caracas for the *next*
    // business day, so between then and midnight the page carries a rate that
    // is not in force, and a deployment with no rate history yet has nothing to
    // fall back on. It resolves itself at midnight Caracas.
    check('a rate is in force', false, why(fx));
    if (fx.body?.error?.code === 'FX_UNAVAILABLE') {
      console.log([
        '',
        '  Two causes look identical here:',
        '    1. BCV published for the next business day and today\'s rate was never',
        '       recorded -- normal on a deployment less than a day old, and it clears',
        '       at midnight Caracas without intervention.',
        '    2. BCV is genuinely unreachable or has changed its page.',
        '',
        '  Check the logs for FX_NOT_YET_IN_FORCE (cause 1) or FX_UNAVAILABLE (cause 2).',
        '  Either way, VES-priced bills are unaffected; only foreign-currency bills',
        '  cannot be opened.'
      ].join('\n'));
    }
  }

  console.log('\nbill, items and split');
  const table = await call('POST', '/api/v1/tables', { body: { name: tag } });
  if (!check('create a table', table.status === 201, why(table))) return;

  const product = await call('POST', '/api/v1/menu/products', {
    body: { name: tag, priceMinorUnits: '1250' }
  });
  if (!check('create a menu product', product.status === 201, why(product))) return;

  const bill = await call('POST', '/api/v1/bills', {
    body: { tableId: table.body.id, totalDueMinorUnits: '0' }
  });
  if (!check('open an itemisable bill', bill.status === 201, why(bill))) return;

  const line = await call('POST', `/api/v1/bills/${bill.body.id}/items`, {
    body: { productId: product.body.id, quantity: 2 }
  });
  check('add a line', line.status === 201, why(line));
  check('line price is snapshotted', line.body?.item?.unitPriceMinor === '1250');
  check('subtotal computed by the database', line.body?.item?.subtotalMinor === '2500');

  const read = await call('GET', `/api/v1/bills/${bill.body.id}`);
  const b = read.body || {};
  check('single-bill read carries its lines', read.status === 200 && b.itemCount === 1, why(read));
  check('total equals its parts',
    BigInt(b.subtotalMinor || 0) + BigInt(b.vatMinor || 0) + BigInt(b.serviceChargeMinor || 0)
      === BigInt(b.totalDue || 0),
    `${b.subtotalMinor} + ${b.vatMinor} + ${b.serviceChargeMinor} = ${b.totalDue}`);
  check('money crosses the wire as strings', typeof b.totalDueVes === 'string' && typeof b.subtotalMinor === 'string');

  const split = await call('POST', `/api/v1/bills/${bill.body.id}/split/preview`, {
    body: { mode: 'EQUAL', participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  });
  if (split.status === 200) {
    const summed = split.body.allocations.reduce((t, a) => t + BigInt(a.amountVes), 0n);
    check('split allocates exactly', summed.toString() === split.body.outstandingVes,
      `${summed} vs ${split.body.outstandingVes}`);
    check('every mode divides the outstanding balance', split.body.outstandingVes === b.totalDueVes);
  } else {
    check('split preview', false, why(split));
  }

  console.log('\nowner dashboard');
  // Short prefix: the schema caps it at 20 characters, and the smoke tag is
  // longer than that.
  const prefix = `S${String(Date.now()).slice(-6)}`;
  const bulk = await call('POST', '/api/v1/tables/bulk', { body: { count: 2, prefix } });
  check('bulk-create tables', bulk.status === 201 && bulk.body.created === 2, why(bulk));

  const again = await call('POST', '/api/v1/tables/bulk', { body: { count: 2, prefix } });
  check('bulk create is idempotent', again.body?.created === 0 && again.body?.alreadyExisted === 2,
    `created=${again.body?.created} existed=${again.body?.alreadyExisted}`);

  const bulkTables = (bulk.body?.data || []).filter(t => t.name.startsWith(prefix));
  const orderTable = bulkTables[0];

  // The waiter path: a table and a list of things, no bill id.
  const order = await call('POST', `/api/v1/bills/tables/${orderTable.id}/order`, {
    body: { items: [{ productId: product.body.id, quantity: 2 }] }
  });
  check('order opens a bill for a table', order.status === 201 && order.body.opened === true, why(order));
  check('order lines land', order.body?.bill?.itemCount === 1 && order.body?.bill?.subtotalMinor === '2500',
    `${order.body?.bill?.itemCount} line, subtotal ${order.body?.bill?.subtotalMinor}`);

  const second = await call('POST', `/api/v1/bills/tables/${orderTable.id}/order`, {
    body: { items: [{ productId: product.body.id, quantity: 1 }] }
  });
  check('a second order joins the same bill', second.body?.opened === false
    && second.body?.bill?.id === order.body?.bill?.id, why(second));

  const floor = await call('GET', '/api/v1/tables/floor');
  const busy = (floor.body?.data || []).find(t => t.id === orderTable.id);
  const free = (floor.body?.data || []).find(t => t.name === bulkTables[1]?.name);
  check('floor view returns every table in one call', floor.status === 200 && floor.body.data.length > 0,
    `${floor.body?.data?.length} tables`);
  check('floor shows the open bill on the busy table', busy?.openBill?.itemCount === 2, why(floor));
  check('a free table carries openBill: null, not absent',
    free !== undefined && free.openBill === null && 'openBill' in free);

  console.log('\nguest flow');
  const qr = await call('GET', `/api/v1/guest/tables/${table.body.id}/qr`);
  if (check('mint a table QR', qr.status === 200, why(qr))) {
    const session = await call('POST', '/api/v1/guest/sessions', { auth: false, body: { qrToken: qr.body.token } });
    if (check('exchange the QR for a session', session.status === 201, why(session))) {
      const guest = await call('GET', '/api/v1/guest/bill', {
        auth: false,
        headers: {
          authorization: `Bearer ${session.body.guestToken}`,
          'x-guest-session': session.body.sessionId
        }
      });
      check('a diner sees the bill', guest.status === 200 && guest.body.id === bill.body.id, why(guest));
      check('internal fields withheld from a guest',
        guest.body?.restaurantId === undefined && guest.body?.fxRateSource === undefined);
    }
  }

  if (ORIGIN) {
    console.log('\nCORS');
    const pre = await fetch(`${BASE}/api/v1/bills`, {
      method: 'OPTIONS',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,x-guest-session'
      }
    });
    check(`${ORIGIN} is allowed`, pre.headers.get('access-control-allow-origin') === ORIGIN,
      pre.headers.get('access-control-allow-origin') || `HTTP ${pre.status} — add it to CORS_ORIGINS`);
  }

  console.log('\ncleanup');
  const voided = await call('POST', `/api/v1/bills/${bill.body.id}/void`);
  check('void the bill', voided.status === 200, why(voided));
  // The order bill carries lines, so remove them before voiding: a bill with
  // payments cannot be voided, and one with lines should not be left open.
  if (order.body?.bill?.id) {
    for (const item of (await call('GET', `/api/v1/bills/${order.body.bill.id}/items`)).body?.data || []) {
      await call('DELETE', `/api/v1/bills/${order.body.bill.id}/items/${item.id}`);
    }
    await call('POST', `/api/v1/bills/${order.body.bill.id}/void`);
  }
  for (const t of bulkTables) await call('PATCH', `/api/v1/tables/${t.id}`, { body: { active: false } });
  await call('DELETE', `/api/v1/menu/products/${product.body.id}`);
  await call('PATCH', `/api/v1/tables/${table.body.id}`, { body: { active: false } });
  console.log(`  left behind: table, product and bill named ${tag}`);
}

main()
  .catch(err => { console.error('\nsmoke test crashed:', err.message); failed++; })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed\n`);
    process.exit(failed ? 1 : 0);
  });
