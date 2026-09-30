const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const config = require('../../src/config');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/utils/tokens');

/**
 * Cómo están montados los limitadores, contra la app de verdad.
 *
 * Los límites se prueban sembrando el contador en vez de gastarlo a base de
 * peticiones: gastar de verdad los cubos por dirección los vacía también para
 * las demás suites de este proceso (ver guestRateLimit.integration.test.js).
 */
describe('rate limit wiring', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let seq = 0;
  const minted = [];

  const IP_KEYS = ['auth:::ffff:127.0.0.1', 'auth:127.0.0.1', 'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'];
  const clear = async () => {
    const staffKeys = await redis.keys('rl:staff:*');
    await redis.del(...IP_KEYS, ...staffKeys);
  };

  const mint = async role => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3) RETURNING id`,
      [restaurant.id, `rl-${++seq}-${restaurant.id}@example.com`, role]
    );
    minted.push(rows[0].id);
    return { id: rows[0].id, token: signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role }) };
  };

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `RL ${Date.now()}` });
  });
  beforeEach(clear);
  after(async () => {
    await clear();
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('leer la sesión no pasa por el límite de intentos de acceso', async () => {
    const owner = await mint('OWNER');
    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${owner.token}` } });
    assert.equal(me.status, 200);
    // El último limitador que responde fija la cabecera: si /me pasara por el
    // de acceso, aquí se leería su techo de diez.
    assert.equal(me.headers.get('x-ratelimit-limit'), String(config.rateLimit.staffMax));

    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `nadie-${Date.now()}@example.com`, password: 'wrong-password-123' })
    });
    assert.equal(login.headers.get('x-ratelimit-limit'), String(config.rateLimit.authMax));
  });

  it('el límite por personal es de cada cuenta, no de la dirección', async () => {
    const a = await mint('OWNER');
    const b = await mint('WAITER');
    await redis.set(`rl:staff:${a.id}`, String(config.rateLimit.staffMax), 'EX', 60);

    const spent = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${a.token}` } });
    assert.equal(spent.status, 429);
    assert.equal((await spent.json()).error.code, 'RATE_LIMITED');

    const other = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${b.token}` } });
    assert.equal(other.status, 200, 'otra cuenta en la misma IP no debería heredar el 429');
  });

  it('un token inventado no abre cubo propio', async () => {
    const res = await fetch(`${base}/api/v1/auth/me`, { headers: { authorization: 'Bearer forged.token.value' } });
    assert.equal(res.status, 401);
    assert.deepEqual(await redis.keys('rl:staff:*'), []);
  });

  it('el invitado ya no comparte un cubo por dirección para todo el local', async () => {
    await fetch(`${base}/api/v1/guest/bill`);
    const perAddress = await redis.exists('guest:::ffff:127.0.0.1', 'guest:127.0.0.1');
    assert.equal(perAddress, 0);
  });
});
