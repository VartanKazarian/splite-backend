const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken, hashToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * Invitar a alguien al equipo, sobre HTTP.
 *
 * Esto decide quién entra en la cuenta de un restaurante, así que casi todo lo
 * de aquí son las formas de que NO entre quien no debe: un enlace usado dos
 * veces, uno caducado, uno reemplazado, uno de otro local, uno que un
 * encargado no debería haber podido crear.
 */
describe('invitaciones al equipo', { skip }, () => {
  let server, base, restaurant, other, ownerToken, managerToken, waiterToken, otherOwnerToken, seq = 0;

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1', 'auth:::ffff:127.0.0.1', 'auth:127.0.0.1'
  );
  beforeEach(clearIpRateLimits);

  const mint = async (tenant, role) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3) RETURNING id`,
      [tenant.id, `${role.toLowerCase()}-${++seq}-${tenant.id}@example.com`, role]
    );
    return signAccessToken({ id: rows[0].id, restaurantId: tenant.id, role });
  };

  const call = async (method, path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };

  const invite = (email, role = 'WAITER', token = ownerToken) =>
    call('POST', '/api/v1/account/invitations', { body: { email, role }, token });
  const tokenOf = link => new URL(link).hash.slice(1);
  const freshEmail = () => `invitado-${Date.now()}-${++seq}@example.com`;

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Invite Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Invite Tenant' });
    ownerToken = await mint(restaurant, 'OWNER');
    managerToken = await mint(restaurant, 'MANAGER');
    waiterToken = await mint(restaurant, 'WAITER');
    otherOwnerToken = await mint(other, 'OWNER');

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const tenant of [restaurant, other]) {
      if (!tenant) continue;
      await db.query('DELETE FROM staff_invitations WHERE restaurant_id = $1', [tenant.id]);
      await fixtures.destroyRestaurant(tenant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('el dueño invita, la persona pone su contraseña y entra', async () => {
    const email = freshEmail();
    const created = await invite(email, 'WAITER');
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const { link, invitation } = created.body;
    assert.match(link, /\/invitacion#[A-Za-z0-9_-]{43}$/, 'el token va en el fragmento, que no llega a ningún servidor');
    assert.equal(invitation.email, email);
    assert.equal(invitation.token, undefined, 'la invitación listada nunca lleva el token');

    const token = tokenOf(link);
    const { rows: [stored] } = await db.query(
      'SELECT token_hash FROM staff_invitations WHERE id = $1', [invitation.id]
    );
    assert.equal(stored.token_hash, hashToken(token), 'se guarda el hash');
    assert.notEqual(stored.token_hash, token, 'y no el token');

    const audit = await db.query(
      `SELECT details::text AS d FROM audit_logs WHERE resource_id = $1`, [invitation.id]
    );
    assert.ok(audit.rows.length >= 1);
    assert.ok(audit.rows.every(r => !r.d.includes(token)), 'el token no acaba en la auditoría');

    const preview = await call('POST', '/api/v1/auth/invitations/preview', { body: { token } });
    assert.equal(preview.status, 200);
    assert.deepEqual(
      { email: preview.body.email, role: preview.body.role, restaurantName: preview.body.restaurantName },
      { email, role: 'WAITER', restaurantName: 'Invite Tenant' }
    );

    const accepted = await call('POST', '/api/v1/auth/invitations/accept', {
      body: { token, password: 'una-contraseña-larga', displayName: 'Luis' }
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.ok(accepted.body.accessToken, 'entra con sesión, como tras un login');
    assert.equal(accepted.body.user.role, 'WAITER');
    assert.equal(accepted.body.user.displayName, 'Luis');

    const login = await call('POST', '/api/v1/auth/login', {
      body: { email, password: 'una-contraseña-larga' }
    });
    assert.equal(login.status, 200, 'y la contraseña es la que puso él');
  });

  it('un enlace sirve una sola vez', async () => {
    const { body } = await invite(freshEmail());
    const token = tokenOf(body.link);
    const first = await call('POST', '/api/v1/auth/invitations/accept', { body: { token, password: 'primera-contraseña' } });
    assert.equal(first.status, 201);
    const second = await call('POST', '/api/v1/auth/invitations/accept', { body: { token, password: 'segunda-contraseña' } });
    assert.equal(second.status, 404);
    assert.equal(second.body.error.code, 'INVITATION_INVALID');
    const preview = await call('POST', '/api/v1/auth/invitations/preview', { body: { token } });
    assert.equal(preview.status, 404, 'ni siquiera se deja ver');
  });

  it('dos clics a la vez en el mismo enlace crean una sola cuenta', async () => {
    const email = freshEmail();
    const { body } = await invite(email);
    const token = tokenOf(body.link);
    const results = await Promise.all([1, 2, 3].map(n => call('POST', '/api/v1/auth/invitations/accept', {
      body: { token, password: `contraseña-numero-${n}` }
    })));
    assert.equal(results.filter(r => r.status === 201).length, 1, JSON.stringify(results.map(r => r.status)));
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)', [email]);
    assert.equal(rows[0].n, 1);
  });

  it('un enlace caducado no sirve', async () => {
    const { body } = await invite(freshEmail());
    await db.query(
      `UPDATE staff_invitations SET created_at = now() - interval '9 days', expires_at = now() - interval '1 day'
        WHERE id = $1`,
      [body.invitation.id]
    );
    const res = await call('POST', '/api/v1/auth/invitations/accept', {
      body: { token: tokenOf(body.link), password: 'una-contraseña-larga' }
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'INVITATION_INVALID');
  });

  it('reenviar anula el enlace anterior', async () => {
    const email = freshEmail();
    const firstLink = (await invite(email)).body.link;
    const secondLink = (await invite(email)).body.link;
    assert.notEqual(firstLink, secondLink);

    const old = await call('POST', '/api/v1/auth/invitations/preview', { body: { token: tokenOf(firstLink) } });
    assert.equal(old.status, 404, 'el enlace viejo puede estar en un chat que ya no controlas');
    const fresh = await call('POST', '/api/v1/auth/invitations/preview', { body: { token: tokenOf(secondLink) } });
    assert.equal(fresh.status, 200);

    const list = await call('GET', '/api/v1/account/invitations', { token: ownerToken });
    assert.equal(list.body.data.filter(i => i.email === email).length, 1, 'una abierta por dirección');
  });

  it('anular una invitación la deja sin efecto', async () => {
    const { body } = await invite(freshEmail());
    const revoked = await call('DELETE', `/api/v1/account/invitations/${body.invitation.id}`, { token: ownerToken });
    assert.equal(revoked.status, 204);
    const res = await call('POST', '/api/v1/auth/invitations/accept', {
      body: { token: tokenOf(body.link), password: 'una-contraseña-larga' }
    });
    assert.equal(res.status, 404);
  });

  it('un encargado no puede invitar a otro encargado ni a un dueño; un mesero no invita', async () => {
    const asManager = await invite(freshEmail(), 'MANAGER', managerToken);
    assert.equal(asManager.status, 403);
    assert.equal(asManager.body.error.code, 'STAFF_ROLE_TOO_HIGH');
    const asManagerOwner = await invite(freshEmail(), 'OWNER', managerToken);
    assert.equal(asManagerOwner.status, 403);
    const ok = await invite(freshEmail(), 'CASHIER', managerToken);
    assert.equal(ok.status, 201, 'a caja sí');
    const asWaiter = await invite(freshEmail(), 'WAITER', waiterToken);
    assert.equal(asWaiter.status, 403);
  });

  it('un encargado no puede anular la invitación de un encargado que hizo el dueño', async () => {
    const { body } = await invite(freshEmail(), 'MANAGER', ownerToken);
    const res = await call('DELETE', `/api/v1/account/invitations/${body.invitation.id}`, { token: managerToken });
    assert.equal(res.status, 403);
  });

  it('otro restaurante no ve ni anula mis invitaciones', async () => {
    const { body } = await invite(freshEmail());
    const list = await call('GET', '/api/v1/account/invitations', { token: otherOwnerToken });
    assert.ok(!list.body.data.some(i => i.id === body.invitation.id));
    const res = await call('DELETE', `/api/v1/account/invitations/${body.invitation.id}`, { token: otherOwnerToken });
    assert.equal(res.status, 404);
  });

  it('una dirección con cuenta en Splite no crea nada, y la invitación sigue abierta', async () => {
    // El correo identifica a una sola persona en todo el sistema.
    const taken = `ocupado-${Date.now()}@example.com`;
    await db.query(
      "INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'WAITER')",
      [other.id, taken]
    );
    const { body } = await invite(taken);
    const res = await call('POST', '/api/v1/auth/invitations/accept', {
      body: { token: tokenOf(body.link), password: 'una-contraseña-larga' }
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'INVITATION_EMAIL_IN_USE');
    const { rows } = await db.query('SELECT accepted_at FROM staff_invitations WHERE id = $1', [body.invitation.id]);
    assert.equal(rows[0].accepted_at, null);
  });

  it('a quien ya está en el equipo no se le invita', async () => {
    const email = `ya-esta-${Date.now()}@example.com`;
    await db.query(
      "INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1, $2, 'x', 'WAITER')",
      [restaurant.id, email]
    );
    const res = await invite(email);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'STAFF_EMAIL_TAKEN');
  });

  it('un token mal formado es un 400, y una contraseña corta también', async () => {
    const bad = await call('POST', '/api/v1/auth/invitations/preview', { body: { token: 'corto' } });
    assert.equal(bad.status, 400);
    const { body } = await invite(freshEmail());
    const short = await call('POST', '/api/v1/auth/invitations/accept', {
      body: { token: tokenOf(body.link), password: 'corta' }
    });
    assert.equal(short.status, 400);
  });
});
