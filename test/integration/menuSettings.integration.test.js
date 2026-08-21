const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const config = require('../../src/config');
const { signAccessToken } = require('../../src/utils/tokens');

/**
 * What the settings screen is told this deployment can do.
 *
 * The photo import is opt-in per deployment, so a server without a key answers
 * 503. Until this flag existed the client had no way to know that in advance:
 * it offered the upload, somebody chose a file, several megabytes went up, and
 * only then did the server say the feature was never available here.
 *
 * End to end rather than a unit test on `isConfigured`, because the point is
 * that the answer reaches the wire -- that is the half a client depends on.
 */
describe('menu settings report what the server can do', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  let token;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Menu settings ${Date.now()}` });
    token = signAccessToken({
      id: '00000000-0000-4000-8000-000000000911',
      restaurantId: restaurant.id,
      role: 'OWNER'
    });
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const settings = async () => {
    const res = await fetch(`${baseUrl}/api/v1/menu/settings`, {
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.status, body: await res.json() };
  };

  it('says the reader is unavailable when no key is configured', async () => {
    const key = config.menuOcr.apiKey;
    try {
      config.menuOcr.apiKey = '';
      const res = await settings();
      assert.equal(res.status, 200);
      assert.equal(res.body.menuOcrAvailable, false);
    } finally {
      config.menuOcr.apiKey = key;
    }
  });

  it('says it is available once one is', async () => {
    const key = config.menuOcr.apiKey;
    try {
      config.menuOcr.apiKey = 'sk-test-not-a-real-key';
      const res = await settings();
      assert.equal(res.body.menuOcrAvailable, true);
    } finally {
      config.menuOcr.apiKey = key;
    }
  });

  it('still carries the charge rates it carried before', async () => {
    // The flag is added beside the settings, not instead of them.
    const res = await settings();
    assert.equal(res.body.id, restaurant.id);
    assert.equal(typeof res.body.menuCurrency, 'string');
    assert.equal(typeof res.body.vatBps, 'number');
    assert.equal(typeof res.body.serviceChargeBps, 'number');
  });

  it('refuses without a token, like every other staff route', async () => {
    const res = await fetch(`${baseUrl}/api/v1/menu/settings`);
    assert.equal(res.status, 401);
  });
});
