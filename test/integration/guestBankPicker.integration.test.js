const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const config = require('../../src/config');
const { signQrPayload } = require('../../src/utils/tokens');

/**
 * Elegir el banco al declarar un pago, sobre HTTP.
 *
 * `bankOrigin` es opcional y no prueba nada por sí solo -- corrobora un Pago
 * Móvil para quien después lo verifica contra la app del banco. Pero cuando
 * viene, el servidor sólo admite un código conocido, y el campo del comensal
 * era una caja de texto: escribir «Banesco» devolvía 400 y **le impedía pagar
 * la cuenta**, por un campo que no tenía obligación de rellenar.
 *
 * Lo que se fija aquí es el camino entero: que el comensal alcanza la lista, y
 * que un código sacado de ella le deja pagar. Comprobar sólo lo segundo dejaría
 * pasar el día en que la lista dejara de servirse -- y sin lista no hay
 * desplegable, que es de donde venía el fallo.
 */
describe('elegir banco al declarar un pago', { skip }, () => {
  let server, base, restaurant, table, seq = 0;

  const request = async (method, path, { body, session, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(session ? { 'x-guest-session': session } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1',
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );
  beforeEach(clearIpRateLimits);

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Bank Picker Tenant' });
    const created = await fixtures.createTable(restaurant.id, { name: 'B1' });
    const { rows } = await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id]
    );
    table = rows[0];

    // Una sola, y con saldo de sobra: `bills_one_open_per_table_idx` no admite
    // dos abiertas en la misma mesa, y las cuatro pruebas declaran contra ésta.
    await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 500000, totalDueVes: 500000
    });

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  /** Escanea el QR. La cuenta ya está abierta: sólo cabe una por mesa. */
  async function seated() {
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: restaurant.id, nonce: table.qr_nonce,
      iat: now, ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const scan = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(scan.status, 201, JSON.stringify(scan.body));
    return { session: scan.body.sessionId, token: scan.body.guestToken };
  }

  const declare = (auth, bankOrigin) => request('POST', '/api/v1/guest/bill/payment-claims', {
    ...auth,
    body: {
      amountVes: '1000',
      reference: String(100000 + (++seq)),
      ...(bankOrigin === undefined ? {} : { bankOrigin })
    }
  });

  it('el comensal alcanza la lista de bancos', async () => {
    // Sin esto no hay desplegable, y sin desplegable el campo vuelve a ser una
    // caja de texto donde cualquier valor razonable impide pagar.
    const auth = await seated();
    const res = await request('GET', '/api/v1/guest/banks', auth);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.data) && res.body.data.length > 0);
    for (const bank of res.body.data) {
      assert.match(bank.code, /^[0-9]{4}$/);
      assert.equal(typeof bank.name, 'string');
    }
  });

  it('un banco elegido de la lista deja pagar', async () => {
    const auth = await seated();
    const list = await request('GET', '/api/v1/guest/banks', auth);
    const first = list.body.data[0];

    const res = await declare(auth, first.code);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('no elegir banco también deja pagar, que para eso es opcional', async () => {
    const auth = await seated();
    const res = await declare(auth, undefined);
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  it('el nombre escrito a mano se rechaza, y dice qué campo fue', async () => {
    /*
     * Es lo que pasaba antes con el campo de texto: «Banesco» es exactamente lo
     * que cualquiera escribe. El rechazo en sí está bien -- un banco que se
     * compara de tres formas no corrobora nada --, lo que estaba mal era
     * ofrecer una caja donde eso se podía escribir.
     *
     * Que el 400 nombre el campo es lo que deja al cliente señalarlo en vez de
     * enseñar un error suelto que no dice qué arreglar.
     */
    const auth = await seated();
    const res = await declare(auth, 'Banesco');

    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(res.body.error.details.fieldPaths.includes('bankOrigin'),
      'el cliente necesita saber cuál de los campos fue');
  });
});
