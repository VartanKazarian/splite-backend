// Must be set before src/config is first required: config reads it at import,
// and src/app only mounts the router when it is on.
process.env.ONBOARDING_ENABLED = 'true';
process.env.ONBOARDING_TEAM_EMAIL = 'onboarding-team@splite.example.com';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const app = require('../../src/app');
const mailer = require('../../src/services/mailer');
const onboarding = require('../../src/services/onboarding');

/**
 * Restaurant registration, over HTTP.
 *
 * The property under test is that the form is a *lead*, not a registration.
 * Submitting it must reach the onboarding team and must not, by itself, produce
 * anything a restaurant can log into — access is granted by a person, after a
 * phone call. Everything asserted about the database before the invitation is
 * there because the obvious implementation passes a happy-path test and still
 * hands out tenants to whoever fills in a form.
 */
describe('restaurant onboarding', { skip }, () => {
  let server;
  let baseUrl;
  let sent = [];
  let seq = 0;

  const TEAM = 'onboarding-team@splite.example.com';
  const originalSend = mailer.send;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    // Captures outbound mail instead of sending it. Also the only way the test
    // can learn a token: only its hash is ever stored.
    mailer.send = async message => { sent.push(message); return { sent: true }; };
  });

  beforeEach(async () => {
    sent = [];
    // Suites share 127.0.0.1 and Redis. These limiters are per *hour* and fail
    // closed, so a leftover count from another file does not merely slow this
    // suite down, it rejects every request in it. Both spellings of localhost,
    // as elsewhere: Node reports the IPv6-mapped form on some hosts.
    await redis.del(
      'api:::ffff:127.0.0.1', 'api:127.0.0.1',
      'onboard:ip:::ffff:127.0.0.1', 'onboard:ip:127.0.0.1',
      'onboard:verify:::ffff:127.0.0.1', 'onboard:verify:127.0.0.1'
    );
    // The per-recipient buckets are keyed by a hash of the address, so they
    // cannot be named ahead of time.
    const hashed = await redis.keys('onboard:email:*');
    if (hashed.length) await redis.del(...hashed);
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

  // RIF is UNIQUE across restaurants, so a fixed pool would make cases collide.
  const freshRif = () => `J-${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}-4`;

  const leadBody = (overrides = {}) => ({
    restaurantName: `Onboarding Test ${++seq}`,
    rif: freshRif(),
    email: `onboard-${seq}-${Date.now()}@splite.example.com`,
    phone: '+58 412 1234567',
    menuCurrency: 'USD',
    profile: { tableCount: 12, posSystem: 'cuaderno', notes: 'Abrimos solo cenas.' },
    ...overrides
  });

  const mailTo = address => sent.filter(m => m.to === address);
  const tokenFromMail = message => {
    const match = /token=([A-Za-z0-9_-]+)/.exec(message.text);
    assert.ok(match, 'the invitation should carry a token');
    return decodeURIComponent(match[1]);
  };

  const leadIdFor = async email => {
    const { rows } = await db.query(
      'SELECT id FROM restaurant_signups WHERE lower(email) = lower($1)', [email]
    );
    assert.equal(rows.length, 1);
    return rows[0].id;
  };

  it('records a lead and creates nothing anyone can log into', async () => {
    const body = leadBody();
    const res = await request('POST', '/api/v1/onboarding/restaurants', body);

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.deepEqual(res.body, { status: 'RECEIVED', email: body.email });

    const users = await db.query('SELECT id FROM users WHERE lower(email) = lower($1)', [body.email]);
    assert.equal(users.rows.length, 0, 'no user may exist');

    const restaurants = await db.query('SELECT id FROM restaurants WHERE rif = $1',
      [body.rif.replace(/[^A-Z0-9]/gi, '').toUpperCase()]);
    assert.equal(restaurants.rows.length, 0, 'no restaurant may exist');

    // And crucially: no credential of any kind was issued. Before this change
    // the form itself minted the link that creates a tenant.
    const { rows } = await db.query(
      'SELECT status, token_hash, expires_at FROM restaurant_signups WHERE lower(email) = lower($1)',
      [body.email]
    );
    assert.equal(rows[0].status, 'NEW');
    assert.equal(rows[0].token_hash, null, 'the form must not mint a token');
    assert.equal(rows[0].expires_at, null);
  });

  it('emails the onboarding team with the details needed to call them', async () => {
    const body = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);

    const toTeam = mailTo(TEAM);
    assert.equal(toTeam.length, 1, 'the team must be told, or the lead dies in a table');
    assert.match(toTeam[0].subject, new RegExp(body.restaurantName));
    assert.ok(toTeam[0].text.includes(body.phone), 'the phone number is the point');
    assert.ok(toTeam[0].text.includes(body.email));
    assert.ok(toTeam[0].text.includes('cuaderno'), 'the profile answers should be readable');
    assert.ok(toTeam[0].text.includes('12'), 'table count');

    // And the applicant is told a human will call, not handed a link.
    const toApplicant = mailTo(body.email);
    assert.equal(toApplicant.length, 1);
    assert.ok(!/token=/.test(toApplicant[0].text), 'the acknowledgement must carry no link');
    assert.match(toApplicant[0].text, /llamará/i);
  });

  it('flags a duplicate to the reviewer and never to the applicant', async () => {
    const first = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', first);
    await onboarding.inviteLead(await leadIdFor(first.email));
    const invite = mailTo(first.email).find(m => /token=/.test(m.text));
    await request('POST', '/api/v1/onboarding/verify', {
      token: tokenFromMail(invite), password: 'a-perfectly-fine-password'
    });

    sent = [];
    const second = await request('POST', '/api/v1/onboarding/restaurants',
      { ...leadBody(), email: first.email });

    // Byte-identical to a first submission: a different status, code or body
    // would tell an unauthenticated caller which addresses have accounts.
    assert.equal(second.status, 202);
    assert.deepEqual(second.body, { status: 'RECEIVED', email: first.email });

    const toTeam = mailTo(TEAM);
    assert.equal(toTeam.length, 1);
    assert.match(toTeam[0].text, /YA TIENE CUENTA/, 'the reviewer should see the duplicate');

    const toApplicant = mailTo(first.email);
    assert.equal(toApplicant.length, 1);
    assert.ok(!/ya tiene cuenta/i.test(toApplicant[0].text), 'the applicant must not be told');
  });

  it('mints the link only when the team invites, and never stores it', async () => {
    const body = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    sent = [];

    await onboarding.inviteLead(await leadIdFor(body.email));

    const invite = mailTo(body.email).find(m => /token=/.test(m.text));
    assert.ok(invite, 'the invitation should be emailed to the restaurant');
    const token = tokenFromMail(invite);

    const { rows } = await db.query(
      'SELECT status, token_hash, invited_at FROM restaurant_signups WHERE lower(email) = lower($1)',
      [body.email]
    );
    assert.equal(rows[0].status, 'INVITED');
    assert.ok(rows[0].invited_at);
    assert.notEqual(rows[0].token_hash, token, 'the raw token must never be stored');
    assert.equal(rows[0].token_hash.length, 64, 'a sha256 hex digest');
  });

  it('creates restaurant, owner and menu defaults on verification, and signs in', async () => {
    const body = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    sent = [];
    await onboarding.inviteLead(await leadIdFor(body.email));
    const token = tokenFromMail(mailTo(body.email).find(m => /token=/.test(m.text)));

    const res = await request('POST', '/api/v1/onboarding/verify', {
      token, password: 'a-perfectly-fine-password'
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

    const account = await fetch(`${baseUrl}/api/v1/account`, {
      headers: { authorization: `Bearer ${res.body.accessToken}` }
    }).then(r => r.json());
    assert.equal(account.plan.tier, 'TRIAL');
    assert.ok(account.plan.trialDaysRemaining > 0);

    const { rows } = await db.query(
      'SELECT status FROM restaurant_signups WHERE lower(email) = lower($1)', [body.email]
    );
    assert.equal(rows[0].status, 'ONBOARDED');
  });

  it('spends the link, so a replayed one creates nothing', async () => {
    const body = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    sent = [];
    await onboarding.inviteLead(await leadIdFor(body.email));
    const token = tokenFromMail(mailTo(body.email).find(m => /token=/.test(m.text)));

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

  it('supersedes the previous link when a lead is re-invited', async () => {
    const body = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    const leadId = await leadIdFor(body.email);

    sent = [];
    await onboarding.inviteLead(leadId);
    const firstToken = tokenFromMail(mailTo(body.email).find(m => /token=/.test(m.text)));

    sent = [];
    await onboarding.inviteLead(leadId);
    const secondToken = tokenFromMail(mailTo(body.email).find(m => /token=/.test(m.text)));
    assert.notEqual(firstToken, secondToken);

    const stale = await request('POST', '/api/v1/onboarding/verify', {
      token: firstToken, password: 'a-perfectly-fine-password'
    });
    assert.equal(stale.status, 401, 'the superseded link must stop working');

    const fresh = await request('POST', '/api/v1/onboarding/verify', {
      token: secondToken, password: 'a-perfectly-fine-password'
    });
    assert.equal(fresh.status, 201);
  });

  it('refuses to invite a lead whose email now has an account', async () => {
    const first = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', first);
    await onboarding.inviteLead(await leadIdFor(first.email));
    const token = tokenFromMail(mailTo(first.email).find(m => /token=/.test(m.text)));
    await request('POST', '/api/v1/onboarding/verify', {
      token, password: 'a-perfectly-fine-password'
    });

    // A second lead arrives for the same address and the reviewer, not reading
    // carefully, tries to invite it too.
    await request('POST', '/api/v1/onboarding/restaurants', { ...leadBody(), email: first.email });
    const { rows } = await db.query(
      "SELECT id FROM restaurant_signups WHERE lower(email) = lower($1) AND status = 'NEW'",
      [first.email]
    );
    await assert.rejects(
      () => onboarding.inviteLead(rows[0].id),
      err => err.code === 'EMAIL_ALREADY_REGISTERED'
    );
  });

  it('requires a phone number, because the next step is a call', async () => {
    const { phone, ...withoutPhone } = leadBody();
    const res = await request('POST', '/api/v1/onboarding/restaurants', withoutPhone);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('accepts the ways a Venezuelan number actually gets written', async () => {
    for (const phone of ['+58 412 1234567', '0412-1234567', '04121234567', '(0212) 555.44.33']) {
      const res = await request('POST', '/api/v1/onboarding/restaurants', leadBody({ phone }));
      assert.equal(res.status, 202, `${phone} should be accepted: ${JSON.stringify(res.body)}`);
    }
  });

  it('will not accept a RIF that is not RIF-shaped', async () => {
    const res = await request('POST', '/api/v1/onboarding/restaurants', leadBody({ rif: 'X-1-2' }));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('rejects a password too short to be one, at verification not submission', async () => {
    const body = leadBody();
    await request('POST', '/api/v1/onboarding/restaurants', body);
    sent = [];
    await onboarding.inviteLead(await leadIdFor(body.email));
    const token = tokenFromMail(mailTo(body.email).find(m => /token=/.test(m.text)));

    const res = await request('POST', '/api/v1/onboarding/verify', { token, password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });
});
