const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/utils/tokens');

/**
 * Cómo se llama quien ha entrado.
 *
 * `users` guardaba correo, rol y contraseña. El panel saluda a quien abre el
 * turno, y sin nombre lo único que quedaba era recortar el correo por la
 * arroba: "gerencia@casa72.com" saludaba a "Gerencia".
 *
 * De extremo a extremo y no una prueba unitaria del servicio, porque lo que
 * importa es que el nombre llega al cable: /auth/me es de donde lo lee el
 * cliente, y que sólo se pueda cambiar el propio es una propiedad de la ruta,
 * no de la función.
 */
describe('a person can say what they are called', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  let userId;
  let otherId;
  let token;

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Display name ${Date.now()}` });

    const insert = async email => {
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role, active)
         VALUES ($1, $2, 'x', 'OWNER', TRUE) RETURNING id`,
        [restaurant.id, email]
      );
      return rows[0].id;
    };
    userId = await insert(`owner-${Date.now()}@example.com`);
    otherId = await insert(`other-${Date.now()}@example.com`);

    token = signAccessToken({ id: userId, restaurantId: restaurant.id, role: 'OWNER' });
  });

  /*
   * /api/v1/auth lleva un limitador de 10 peticiones por minuto y por IP, y
   * esta prueba hace más de diez. El limitador es la política correcta -- no se
   * toca -- así que lo que se limpia es su contador, que es lo que haría el
   * minuto siguiente.
   */
  beforeEach(async () => {
    const keys = await redis.keys('*auth*').catch(() => []);
    if (keys.length) await redis.del(...keys).catch(() => {});
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant?.id]).catch(() => {});
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const me = async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    return { status: res.status, body: await res.json() };
  };

  const setName = async displayName => {
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName })
    });
    return { status: res.status, body: await res.json() };
  };

  it('starts with no name, and says so rather than omitting it', async () => {
    const res = await me();
    assert.equal(res.status, 200);
    // Presente y null, no ausente: un cliente que distingue "no lo ha puesto"
    // de "el campo no existe" puede decidir qué enseñar mientras tanto.
    assert.ok('displayName' in res.body.user);
    assert.equal(res.body.user.displayName, null);
  });

  it('keeps the name and hands it back from /me', async () => {
    const saved = await setName('Vartan');
    assert.equal(saved.status, 200);
    assert.equal(saved.body.user.displayName, 'Vartan');

    const res = await me();
    assert.equal(res.body.user.displayName, 'Vartan');
  });

  it('trims, because a leading space is not part of a name', async () => {
    const saved = await setName('  Ana María  ');
    assert.equal(saved.body.user.displayName, 'Ana María');
  });

  it('an empty string clears it instead of storing a blank name', async () => {
    await setName('Vartan');
    const cleared = await setName('');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.user.displayName, null);
  });

  it('refuses a name longer than the column allows', async () => {
    const res = await setName('a'.repeat(81));
    assert.equal(res.status, 400);
  });

  it('does not touch the role, the email or the restaurant', async () => {
    const was = await me();
    await setName('Alguien');
    const now = await me();
    assert.equal(now.body.user.role, was.body.user.role);
    assert.equal(now.body.user.email, was.body.user.email);
    assert.equal(now.body.user.restaurantId, was.body.user.restaurantId);
  });

  it('cannot rename anybody else, aunque se mande el id de otro', async () => {
    await setName('Sólo yo');

    // El validador va con `stripUnknown`, así que un `userId` de más no da 400:
    // se cae del cuerpo antes de llegar al servicio. Da igual -- el id contra el
    // que se escribe sale del token, no del cuerpo, así que no hay nada que
    // mandar para renombrar a otra persona. Lo que se comprueba es eso: que la
    // otra cuenta sigue sin nombre y la mía es la que cambió.
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Suplantado', userId: otherId, id: otherId })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.id, userId, 'el usuario devuelto es el del token');
    assert.equal(body.user.displayName, 'Suplantado');

    const { rows } = await db.query('SELECT display_name FROM users WHERE id = $1', [otherId]);
    assert.equal(rows[0].display_name, null, 'la otra cuenta sigue sin nombre');
  });

  it('needs a session', async () => {
    const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Nadie' })
    });
    assert.equal(res.status, 401);
  });
});
