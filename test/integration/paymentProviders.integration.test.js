process.env.PAYMENT_CREDENTIALS_KEYS = `1:${require('node:crypto').randomBytes(32).toString('base64')}`;

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/utils/tokens');
const providerConfigs = require('../../src/payments/providerConfigs');

/**
 * Bank credentials end to end.
 *
 * The assertions that matter are about what does *not* come back, and about
 * what the database refuses.
 */
describe('payment provider credentials', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  let ownerToken;
  let managerToken;

  const CREDS = {
    merchantId: 'M-9001', clientId: 'C-9001', secretKey: 'a-very-secret-key-9001',
    integratorId: 'I-9001', terminalId: 'T-9001'
  };

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Creds ${Date.now()}` });

    const mint = role => signAccessToken({
      id: `00000000-0000-4000-8000-0000000009${role === 'OWNER' ? '01' : '02'}`,
      restaurantId: restaurant.id, role
    });
    ownerToken = mint('OWNER');
    managerToken = mint('MANAGER');
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const call = async (method, path, token, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, raw: text, body: text ? JSON.parse(text) : null };
  };

  it('stores credentials and never echoes them', async () => {
    const res = await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);
    assert.equal(res.status, 200, res.raw);

    for (const value of Object.values(CREDS)) {
      assert.ok(!res.raw.includes(value), `response leaked ${value}`);
    }
    assert.equal(res.body.configured, true);
    assert.equal(res.body.enabled, false, 'storing is not switching on');
    assert.equal(res.body.credentialsValidatedAt, null);
  });

  it('writes ciphertext, not the credential, to the database', async () => {
    await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);

    const { rows } = await db.query(
      'SELECT credentials_encrypted, key_version FROM payment_provider_configs WHERE restaurant_id = $1',
      [restaurant.id]
    );
    const stored = rows[0].credentials_encrypted.toString('utf8');
    for (const value of Object.values(CREDS)) {
      assert.ok(!stored.includes(value), `database holds plaintext: ${value}`);
    }
    assert.equal(rows[0].key_version, 1);
  });

  it('the list endpoint returns metadata only', async () => {
    await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);
    const res = await call('GET', '/api/v1/account/payment-providers', ownerToken);

    assert.equal(res.status, 200);
    for (const value of Object.values(CREDS)) {
      assert.ok(!res.raw.includes(value), `list leaked ${value}`);
    }
    assert.deepEqual(res.body.supported, ['MERCANTIL']);
  });

  it('will not let a manager store credentials', async () => {
    // MANAGER may set the payee. These let software move money, which is a
    // different kind of authority.
    const res = await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', managerToken, CREDS);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('rejects a field nobody asked for rather than sealing it', async () => {
    const res = await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, {
      ...CREDS, password: 'this-should-not-be-stored'
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('rejects a provider with no adapter', async () => {
    const res = await call('PUT', '/api/v1/account/payment-providers/BANESCO', ownerToken, CREDS);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'PAYMENT_PROVIDER_UNKNOWN');
  });

  it('replacing credentials switches the rail back off', async () => {
    // New credentials are unproven credentials, however good the old ones were.
    // A mistyped secret key must not leave a rail on and quietly broken.
    await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);
    await providerConfigs.markValidated({
      restaurantId: restaurant.id, provider: 'MERCANTIL', enable: true
    });

    const initial = await call('GET', '/api/v1/account/payment-providers', ownerToken);
    assert.equal(initial.body.data[0].enabled, true);

    const res = await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, {
      ...CREDS, secretKey: 'a-different-key'
    });
    assert.equal(res.body.enabled, false);
    assert.equal(res.body.credentialsValidatedAt, null);
  });

  it('the database refuses to enable unproven credentials', async () => {
    // The guarantee behind the service logic: a restaurant believing it takes
    // payments, on a merchant id nobody ever exercised, is the quiet failure.
    await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);
    await assert.rejects(
      () => db.query(
        `UPDATE payment_provider_configs SET enabled = TRUE, credentials_validated_at = NULL
          WHERE restaurant_id = $1 AND provider = 'MERCANTIL'`,
        [restaurant.id]
      ),
      err => {
        assert.equal(err.code, '23514');
        assert.match(err.constraint, /enabled_requires_validation/);
        return true;
      }
    );
  });

  it('an adapter can read back exactly what was stored', async () => {
    // The one path that returns plaintext, and it is not reachable from a route.
    await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);
    const loaded = await providerConfigs.loadCredentials({
      restaurantId: restaurant.id, provider: 'MERCANTIL'
    });
    assert.deepEqual(loaded.credentials, CREDS);
    assert.equal(loaded.enabled, false);
  });

  it('deletes on request', async () => {
    await call('PUT', '/api/v1/account/payment-providers/MERCANTIL', ownerToken, CREDS);
    assert.equal((await call('DELETE', '/api/v1/account/payment-providers/MERCANTIL', ownerToken)).status, 204);

    const updated = await call('GET', '/api/v1/account/payment-providers', ownerToken);
    assert.deepEqual(updated.body.data, []);
  });
});
