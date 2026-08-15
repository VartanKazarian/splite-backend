// Must be set before src/config is first required: config reads it at import,
// and src/app only mounts the router when it is on.
process.env.ONBOARDING_ENABLED = 'true';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const app = require('../../src/app');
const mailer = require('../../src/services/mailer');

/**
 * Self-service registration, over HTTP.
 *
 * The property under test is not "a restaurant can register" -- it is that
 * *nothing exists* until the emailed link is used. Every assertion about the
 * database before verification is there because the obvious implementation,
 * insert-then-email, passes a happy-path test and still hands an attacker a
 * permanent lock on any address they care to name.
 */
describe('self-service onboarding', { skip }, () => {
  let server;
  let baseUrl;
  let sent = [];
  let seq = 0;

  // Captures outbound mail instead of sending it. Also the only way the test
  // can learn a token: only its hash is ever stored.
  const originalSend = mailer.send;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    mailer.send = async message => { sent.push(message); return { sent: true }; };
  });

  beforeEach(async () => {
    sent = [];
    // Suites share 127.0.0.1, and these limiters are per-hour and fail closed,
    // so a leftover count from another file would reject every request here.
    const keys = await redis.keys('onboard:*');
    if (keys.length) await redis.del(...keys);
  });

  after(async () => {
    mailer.send = originalSend;
    if (server) await new Promise(resolve => server.close(resolve));
    await db.query("DELETE FROM restaurant_signups WHERE email LIKE 'onboard-%'");
    await db.query(
      `DELETE FROM restaurants WHERE id IN (
         SELECT restaurant_id FROM users WHERE email LIKE 'onboard-%'
       )`
    );
    await db.close();
    await closeRedis();
  });

  const request = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // RIF is UNIQUE across restaurants, so a fixed pool of them would make cases
  // collide with each other and fail as "already registered" -- which is the
  // silent branch, so they would fail confusingly.
  const freshRif = () => `J-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}-4`;

  const signupBody = (overrides = {}) => ({
    restaurantName: `Onboarding Test ${++seq}`,
    rif: freshRif(),
    email: `onboard-${seq}-${Date.now()}@splite.example.com`,
    menuCurrency: 'USD',
    profile: { tableCount: 12, posSystem: 'cuaderno', notes: 'Abrimos solo cenas.' },
    ...overrides
  });

  const tokenFromLastMail = () => {
    const match = /token=([A-Za-z0-9_-]+)/.exec(sent.at(-1).text);
    assert.ok(match, 'the verification mail should carry a token');
    return decodeURIComponent(match[1]);
  };

  it('creates no tenant before the link is used', async () => {
    const body = signupBody();
    const res = await request('POST', '/api/v1/onboarding/restaurants', body);

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.status, 'PENDING_VERIFICATION');

    // The whole point. An unverified signup must not hold the globally unique
    // email, or registering someone else's address locks them out for good.
    const users = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [body.email]);
    assert.equal(users.rows.length, 0, 'no user may exist yet');

    const restaurants = await db.query('SELECT id FROM restaurants WHERE rif = $1', [
      body.rif.replace(/[^A-Z0-9]/gi, '').toUpperCase()
    ]);
    assert.equal(restaurants.rows.length, 0, 'no restaurant may exist yet');

    const signups = await db.query(
      'SELECT token_hash, consumed_at FROM restaurant_signups WHERE lower(email) = lower($1)',
      [body.email]
    );
    assert.equal(signups.rows.length, 1);
    assert.equal(signups.rows[0].consumed_at, null);
  });

  it('never stores the token it emailed', async () => {
    await request('POST', '/api/v1/onboarding/restaurants', signupBody());
    const token = tokenFromLastMail();

    const { rows } = await db.query(
      'SELECT token_hash FROM restaurant_signups ORDER BY created_at DESC LIMIT 1'
    );
    assert.notEqual(rows[0].token_hash, token, 'the raw token must never be stored');
    assert.equal(rows[0].token_hash.length, 64, 'a sha256 hex digest');
  });

  it('creates restaurant, owner and menu defaults in one step, and signs in', async () => {
    const body = signupBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);

    const res = await request('POST', '/api/v1/onboarding/verify', {
      token: tokenFromLastMail(),
      password: 'a-perfectly-fine-password'
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.restaurant.name, body.restaurantName);
    assert.equal(res.body.restaurant.menuCurrency, 'USD');
    // Migration 011 defaults these to zero so it could not reprice existing
    // bills. A restaurant created today has no such history and owes IVA.
    assert.equal(res.body.restaurant.vatBps, 1600);
    assert.equal(res.body.restaurant.serviceChargeBps, 1000);

    assert.ok(res.body.accessToken, 'should be signed in');
    assert.equal(res.body.user.role, 'OWNER');
    assert.equal(res.body.user.email, body.email);

    // And the trial is real, not a null column.
    const account = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { authorization: `Bearer ${res.body.accessToken}` }
    }).then(r => r.json());
    assert.equal(account.plan.tier, 'TRIAL');
    assert.ok(account.plan.trialDaysRemaining > 0, 'trial should be in the future');
    assert.equal(account.rif, body.rif.replace(/[^A-Z0-9]/gi, '').toUpperCase());
  });

  it('spends the link, so a replayed one creates nothing', async () => {
    await request('POST', '/api/v1/onboarding/restaurants', signupBody());
    const token = tokenFromLastMail();

    const first = await request('POST', '/api/v1/onboarding/verify', {
      token, password: 'a-perfectly-fine-password'
    });
    assert.equal(first.status, 201);

    const replay = await request('POST', '/api/v1/onboarding/verify', {
      token, password: 'a-perfectly-fine-password'
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, 'ONBOARDING_TOKEN_INVALID');
  });

  it('answers identically for an address that is already registered', async () => {
    const body = signupBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    await request('POST', '/api/v1/onboarding/verify', {
      token: tokenFromLastMail(), password: 'a-perfectly-fine-password'
    });

    sent = [];
    const second = await request('POST', '/api/v1/onboarding/restaurants', {
      ...signupBody(), email: body.email
    });

    // Byte-identical to a first-time registration. A different status, code or
    // body here would tell an unauthenticated caller which addresses have
    // accounts -- the enumeration oracle that /auth/login pays for a decoy
    // Argon2 hash to avoid.
    assert.equal(second.status, 202);
    assert.deepEqual(second.body, { status: 'PENDING_VERIFICATION', email: body.email });

    // No second signup row was created for it.
    const { rows } = await db.query(
      'SELECT id FROM restaurant_signups WHERE lower(email) = lower($1) AND consumed_at IS NULL',
      [body.email]
    );
    assert.equal(rows.length, 0);

    // The mail that did go out says an account already exists -- to the inbox,
    // where only its owner can read it.
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /intentó registrar/i);
  });

  it('supersedes an outstanding link when the form is submitted again', async () => {
    const body = signupBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    const firstToken = tokenFromLastMail();

    await request('POST', '/api/v1/onboarding/restaurants', { ...body, restaurantName: 'Renamed' });
    const secondToken = tokenFromLastMail();
    assert.notEqual(firstToken, secondToken);

    const stale = await request('POST', '/api/v1/onboarding/verify', {
      token: firstToken, password: 'a-perfectly-fine-password'
    });
    assert.equal(stale.status, 401, 'the superseded link must stop working');

    const fresh = await request('POST', '/api/v1/onboarding/verify', {
      token: secondToken, password: 'a-perfectly-fine-password'
    });
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.restaurant.name, 'Renamed');
  });

  it('records the profile answers without letting them reach the tenant', async () => {
    const body = signupBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);

    const { rows } = await db.query(
      'SELECT profile, rif_checksum_ok FROM restaurant_signups WHERE lower(email) = lower($1)',
      [body.email]
    );
    assert.equal(rows[0].profile.tableCount, 12);
    assert.equal(rows[0].profile.posSystem, 'cuaderno');
    assert.equal(typeof rows[0].rif_checksum_ok, 'boolean');
  });

  it('rejects a password too short to be one, at verification not signup', async () => {
    await request('POST', '/api/v1/onboarding/restaurants', signupBody());
    const res = await request('POST', '/api/v1/onboarding/verify', {
      token: tokenFromLastMail(), password: 'short'
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('will not accept a RIF that is not RIF-shaped', async () => {
    const res = await request('POST', '/api/v1/onboarding/restaurants', signupBody({ rif: 'X-1-2' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });
});
