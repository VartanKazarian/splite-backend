const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const auth = require('../../src/services/auth');

/**
 * El refresh token del personal en una cookie HttpOnly.
 *
 * Con `X-Refresh-Mode: cookie`, ningún script de la página llega a ver el
 * token: entra en una cookie que sólo el navegador manda a la API. Sin la
 * cabecera, todo sigue como antes, para el panel servido desde un dominio que
 * no comparte sitio con la API.
 */
describe('staff refresh token in an HttpOnly cookie', { skip }, () => {
  let server;
  let base;
  let restaurant;
  const email = `cookie-${Date.now()}@example.com`;
  const password = 'una-contraseña-bien-larga';

  const call = async (method, path, { body, cookie, mode = true, origin } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(mode ? { 'x-refresh-mode': 'cookie' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text ? JSON.parse(text) : null,
      setCookie: res.headers.getSetCookie?.() ?? [],
      headers: res.headers
    };
  };
  const cookieOf = (res) => {
    const line = res.setCookie.find(c => c.startsWith('__Host-splite_rt='));
    return line ? line.split(';')[0] : null;
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Cookie Tenant' });
    await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1, $2, $3, 'MANAGER')`,
      [restaurant.id, email, await auth.hashPassword(password)]);
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'auth:::ffff:127.0.0.1', 'auth:127.0.0.1'));

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM refresh_sessions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('login in cookie mode sets an HttpOnly, Secure, SameSite=Strict, host-only cookie and leaves the body without the token', async () => {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.accessToken);
    assert.equal(res.body.refreshToken, undefined, 'no script can read what is not in the body');
    assert.equal(res.body.refreshDelivery, 'cookie');

    const line = res.setCookie.find(c => c.startsWith('__Host-splite_rt='));
    assert.ok(line, 'cookie set');
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(line.includes(attr), attr);
    assert.ok(!/Domain=/i.test(line), 'host-only: no other subdomain can read or overwrite it');
    const maxAge = Number(/Max-Age=(\d+)/.exec(line)[1]);
    assert.ok(maxAge > 11 * 3600 && maxAge <= 12 * 3600, `lasts the idle window, got ${maxAge}`);
  });

  it('without the header nothing changes: the token comes back in the body and no cookie is set', async () => {
    const res = await call('POST', '/api/v1/auth/login', { body: { email, password }, mode: false });
    assert.equal(res.status, 200);
    assert.ok(res.body.refreshToken);
    assert.equal(res.body.refreshDelivery, undefined);
    assert.equal(cookieOf(res), null);

    const refreshed = await call('POST', '/api/v1/auth/refresh', { body: { refreshToken: res.body.refreshToken }, mode: false });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.refreshToken);
  });

  it('refresh reads the cookie, rotates it, and the old one stops working', async () => {
    const login = await call('POST', '/api/v1/auth/login', { body: { email, password } });
    const first = cookieOf(login);

    const refreshed = await call('POST', '/api/v1/auth/refresh', { cookie: first });
    assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
    assert.ok(refreshed.body.accessToken);
    assert.equal(refreshed.body.refreshToken, undefined);
    const second = cookieOf(refreshed);
    assert.ok(second && second !== first, 'a new cookie replaces the old');

    // Reusing a rotated token is treated as theft, as with body tokens.
    const reused = await call('POST', '/api/v1/auth/refresh', { cookie: first });
    assert.equal(reused.status, 401);
    assert.ok(reused.setCookie.some(c => c.startsWith('__Host-splite_rt=;') && /Max-Age=0/.test(c)),
      'a dead cookie is cleared');
  });

  it('the cookie alone is not enough: without the header a refresh is refused', async () => {
    const login = await call('POST', '/api/v1/auth/login', { body: { email, password } });
    const res = await call('POST', '/api/v1/auth/refresh', { cookie: cookieOf(login), mode: false });
    assert.equal(res.status, 401);
  });

  it('a refresh with neither body nor cookie is refused', async () => {
    const res = await call('POST', '/api/v1/auth/refresh', {});
    assert.equal(res.status, 401);
  });

  it('logout revokes the session behind the cookie and clears it', async () => {
    const login = await call('POST', '/api/v1/auth/login', { body: { email, password } });
    const cookie = cookieOf(login);
    const out = await call('POST', '/api/v1/auth/logout', { cookie });
    assert.equal(out.status, 204);
    assert.ok(out.setCookie.some(c => c.startsWith('__Host-splite_rt=;') && /Max-Age=0/.test(c)));
    assert.equal((await call('POST', '/api/v1/auth/refresh', { cookie })).status, 401, 'the session is gone');
  });

  it('CORS lets an allowed origin send the header with credentials', async () => {
    const res = await fetch(base + '/api/v1/auth/refresh', {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-refresh-mode'
      }
    });
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.match(res.headers.get('access-control-allow-headers') || '', /X-Refresh-Mode/i);
  });
});
