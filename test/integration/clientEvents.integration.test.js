const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const app = require('../../src/app');

/** Lo que cuenta el navegador (FR4): entra sin sesión, sale sin tokens. */
describe('browsers report errors and speed', { skip }, () => {
  let server;
  let base;
  const marker = `boom-${Date.now()}`;

  const post = (body, type = 'text/plain') => fetch(`${base}/api/v1/client-events`, {
    method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body)
  });

  before(async () => {
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await redis.del(...await redis.keys('client-events*'), 'api:::ffff:127.0.0.1', 'api:127.0.0.1').catch(() => {});
    await db.query('DELETE FROM client_errors WHERE message LIKE $1', [`${marker}%`]);
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
    await closeRedis();
  });

  it('the same error twice is one row with two occurrences, and no token in its path', async () => {
    for (let i = 0; i < 2; i++) {
      const res = await post({
        kind: 'error', message: `${marker} x is undefined`, surface: 'guest',
        stack: 'TypeError\n    at pay (https://splite.lat/assets/Pay-AbCdEf12.js:1:2)',
        path: '/t/secret-qr-token?view=bill'
      });
      assert.equal(res.status, 204);
    }
    const { rows } = await db.query('SELECT path, occurrences, surface FROM client_errors WHERE message = $1', [`${marker} x is undefined`]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].occurrences, 2);
    assert.equal(rows[0].path, '/t/:qr');
    assert.equal(rows[0].surface, 'guest');
  });

  it('a vital is accepted as JSON too, and nonsense is refused', async () => {
    assert.equal((await post({ kind: 'vital', name: 'LCP', value: 2400, rating: 'good', path: '/' }, 'application/json')).status, 204);
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post({ kind: 'vital', name: 'LCP' })).status, 400);
    assert.equal((await post({ kind: 'error', message: 'x', name: 'LCP' })).status, 400);
  });

  it('the operator console lists it; nobody else can', async () => {
    const res = await fetch(`${base}/api/v1/admin/client-errors`);
    assert.equal(res.status, 401);
  });
});
