const { describe, it, before, beforeEach, after, mock } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const auth = require('../../src/services/auth');
const mailer = require('../../src/services/mailer');

/**
 * «¿Olvidaste tu contraseña?»
 *
 * Antes, un dueño que olvidaba la contraseña no tenía forma de volver a entrar.
 * Lo que tiene que cumplirse: la respuesta no delata qué correos tienen cuenta,
 * el enlace sirve una vez y caduca, pedir otro anula el anterior, y usarlo
 * cierra todas las sesiones.
 */
describe('forgot password', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let sent = [];
  let seq = 0;
  const OLD = 'la-contraseña-de-antes';
  const NEW = 'una-contraseña-nueva-y-larga';

  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const newUser = async () => {
    const email = `reset-${Date.now()}-${++seq}@example.com`;
    await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1, $2, $3, 'OWNER')`,
      [restaurant.id, email, await auth.hashPassword(OLD)]);
    return email;
  };
  // El correo sale fuera de la petición: se espera a que llegue.
  const linkSentTo = async (email) => {
    for (let i = 0; i < 50; i++) {
      const mail = sent.filter(m => m.to === email).pop();
      if (mail) return /\/restablecer#([A-Za-z0-9_-]{43})/.exec(mail.text)[1];
      await new Promise(r => setTimeout(r, 20));
    }
    return null;
  };
  const login = (email, password) => call('/api/v1/auth/login', { email, password });

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Password Reset Tenant' });
    mock.method(mailer, 'send', async (message) => { sent.push(message); return { sent: true }; });
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    sent = [];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', 'auth:::ffff:127.0.0.1', 'auth:127.0.0.1');
  });

  after(async () => {
    mock.restoreAll();
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM password_resets WHERE user_id IN (SELECT id FROM users WHERE restaurant_id = $1)', [restaurant.id]);
      await db.query('DELETE FROM refresh_sessions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('the answer is the same whether or not the address has an account', async () => {
    const known = await call('/api/v1/auth/password/forgot', { email: await newUser() });
    const unknown = await call('/api/v1/auth/password/forgot', { email: `nadie-${Date.now()}@example.com` });
    assert.equal(known.status, 202);
    assert.deepEqual(unknown, known);
  });

  it('the emailed link sets a new password once, and signs out every session', async () => {
    const email = await newUser();
    const earlier = await login(email, OLD);
    assert.equal(earlier.status, 200);

    assert.equal((await call('/api/v1/auth/password/forgot', { email: email.toUpperCase() })).status, 202);
    const token = await linkSentTo(email);
    assert.ok(token, 'a link was emailed, case-insensitively');

    const reset = await call('/api/v1/auth/password/reset', { token, password: NEW });
    assert.equal(reset.status, 204, JSON.stringify(reset.body));

    assert.equal((await login(email, OLD)).status, 401, 'the old password is gone');
    assert.equal((await login(email, NEW)).status, 200, 'the new one works');
    assert.equal((await call('/api/v1/auth/refresh', { refreshToken: earlier.body.refreshToken })).status, 401,
      'sessions from before the reset are signed out');

    const again = await call('/api/v1/auth/password/reset', { token, password: 'otra-contraseña-distinta' });
    assert.equal(again.status, 400);
    assert.equal(again.body.error.code, 'PASSWORD_RESET_INVALID', 'a link works once');
  });

  it('asking again cancels the previous link', async () => {
    const email = await newUser();
    await call('/api/v1/auth/password/forgot', { email });
    const first = await linkSentTo(email);
    sent = [];
    await call('/api/v1/auth/password/forgot', { email });
    const second = await linkSentTo(email);
    assert.notEqual(first, second);
    assert.equal((await call('/api/v1/auth/password/reset', { token: first, password: NEW })).status, 400);
    assert.equal((await call('/api/v1/auth/password/reset', { token: second, password: NEW })).status, 204);
  });

  it('an expired link does not work', async () => {
    const email = await newUser();
    await call('/api/v1/auth/password/forgot', { email });
    const token = await linkSentTo(email);
    await db.query(
      `UPDATE password_resets SET expires_at = NOW() - INTERVAL '1 second'
        WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
    const res = await call('/api/v1/auth/password/reset', { token, password: NEW });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'PASSWORD_RESET_INVALID');
    assert.equal((await login(email, OLD)).status, 200, 'the password did not change');
  });

  it('a made-up token, or a short password, is refused', async () => {
    const madeUp = await call('/api/v1/auth/password/reset', { token: 'a'.repeat(43), password: NEW });
    assert.equal(madeUp.status, 400);
    assert.equal(madeUp.body.error.code, 'PASSWORD_RESET_INVALID');
    const email = await newUser();
    await call('/api/v1/auth/password/forgot', { email });
    const token = await linkSentTo(email);
    assert.equal((await call('/api/v1/auth/password/reset', { token, password: 'corta' })).status, 400);
  });

  it('at most three links per account per hour; the answer does not change', async () => {
    const email = await newUser();
    for (let i = 0; i < 4; i++) {
      assert.equal((await call('/api/v1/auth/password/forgot', { email })).status, 202);
    }
    await new Promise(r => setTimeout(r, 200));
    assert.equal(sent.filter(m => m.to === email).length, 3);
  });

  it('an inactive account gets no link', async () => {
    const email = await newUser();
    await db.query('UPDATE users SET active = false WHERE email = $1', [email]);
    assert.equal((await call('/api/v1/auth/password/forgot', { email })).status, 202);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(sent.filter(m => m.to === email).length, 0);
  });

  it('the link is not stored: only its hash is', async () => {
    const email = await newUser();
    await call('/api/v1/auth/password/forgot', { email });
    const token = await linkSentTo(email);
    const stored = await db.query(
      `SELECT token_hash FROM password_resets WHERE user_id = (SELECT id FROM users WHERE email = $1)`, [email]);
    assert.ok(stored.rows.every(r => r.token_hash !== token));
  });
});
