const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const config = require('../../src/config');
const auth = require('../../src/services/auth');

/**
 * Cuánto dura una sesión de personal.
 *
 * Doce horas sin usarse, y como mucho dieciséis desde el inicio de sesión se
 * use o no. Antes eran catorce días sin usarse y ningún tope: un token robado
 * que se renovara a tiempo, o una tablet de caja que nunca se apaga, no
 * caducaba nunca. Una sesión de personal confirma pagos.
 */
describe('staff session lifetime', { skip }, () => {
  let restaurant;
  let user;

  const HOUR = 3600;
  const secondsLeft = (token) => jwt.decode(token).exp - Math.floor(Date.now() / 1000);
  const row = async (token) => (await db.query(
    `SELECT session_started_at, expires_at, revoked_at,
            EXTRACT(EPOCH FROM (expires_at - NOW()))::int AS left_s
       FROM refresh_sessions WHERE id = $1`, [jwt.decode(token).jti])).rows[0];
  const backdate = (token, seconds) => db.query(
    `UPDATE refresh_sessions SET session_started_at = NOW() - make_interval(secs => $2) WHERE id = $1`,
    [jwt.decode(token).jti, seconds]);

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Session Lifetime Tenant' });
    user = (await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'MANAGER') RETURNING id, restaurant_id, email, role, display_name`,
      [restaurant.id, `lifetime-${restaurant.id}@example.com`]
    )).rows[0];
  });

  after(async () => {
    if (restaurant) {
      await db.query('DELETE FROM refresh_sessions WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('defaults to 12 hours idle and 16 hours from login', () => {
    assert.equal(config.jwt.refreshTtlSeconds, 12 * HOUR);
    assert.equal(config.jwt.sessionMaxSeconds, 16 * HOUR);
  });

  it('a new login lasts the idle window, in the token and in the database', async () => {
    const { refreshToken } = await auth.issueSession(user);
    assert.ok(Math.abs(secondsLeft(refreshToken) - 12 * HOUR) <= 5);
    assert.ok(Math.abs((await row(refreshToken)).left_s - 12 * HOUR) <= 5);
  });

  it('refreshing renews the idle window but keeps the login time', async () => {
    const first = await auth.issueSession(user);
    await backdate(first.refreshToken, 2 * HOUR);
    const startedAt = (await row(first.refreshToken)).session_started_at;

    const second = await auth.refresh(first.refreshToken);
    assert.equal(
      (await row(second.refreshToken)).session_started_at.getTime(), startedAt.getTime(),
      'the cap counts from the login, not from the refresh');
    assert.ok(Math.abs(secondsLeft(second.refreshToken) - 12 * HOUR) <= 5);
  });

  it('near the cap, the renewed token stops at the cap instead of running 12 more hours', async () => {
    const first = await auth.issueSession(user);
    await backdate(first.refreshToken, 15.5 * HOUR);
    const second = await auth.refresh(first.refreshToken);

    const left = secondsLeft(second.refreshToken);
    assert.ok(left > 25 * 60 && left <= 30 * 60, `expected about 30 minutes, got ${left}s`);
    assert.ok(Math.abs((await row(second.refreshToken)).left_s - left) <= 5);
  });

  it('past the cap, refreshing is refused however recently the session was used', async () => {
    const first = await auth.issueSession(user);
    await backdate(first.refreshToken, 16 * HOUR + 60);

    await assert.rejects(auth.refresh(first.refreshToken), err => {
      assert.equal(err.code, 'INVALID_CREDENTIALS');
      assert.match(err.message, /maximum length/);
      return true;
    });
    assert.ok((await row(first.refreshToken)).revoked_at, 'and that token cannot be tried again');
  });

  it('an idle session past 12 hours is refused, as before', async () => {
    const first = await auth.issueSession(user);
    await db.query(
      "UPDATE refresh_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1",
      [jwt.decode(first.refreshToken).jti]);
    await assert.rejects(auth.refresh(first.refreshToken), err => err.code === 'INVALID_CREDENTIALS');
  });
});
