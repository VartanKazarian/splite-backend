const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * El RIF del emisor, sobre HTTP.
 *
 * Que el formulario guarde es lo de menos. Lo que se fija aquí son las tres
 * reglas que lo separan de un campo de perfil: que un gerente no pueda cambiar
 * de contribuyente, que dos restaurantes no compartan RIF, y sobre todo **que
 * deje de poder tocarse en cuanto se ha emitido** -- que es lo que evita que el
 * libro de ventas deje de cuadrar con el papel que tiene el cliente.
 */
describe('el RIF del emisor sobre HTTP', { skip }, () => {
  let server, base, restaurant, ownerToken, managerToken, seq = 0;

  const request = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const setRif = (rif, token = ownerToken) => request('PUT', '/api/v1/account/rif', { rif }, token);

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1', 'auth:::ffff:127.0.0.1', 'auth:127.0.0.1'
  );

  /** Una factura emitida por este restaurante, que es lo que echa el cerrojo. */
  const issueOne = async () => {
    const table = await fixtures.createTable(restaurant.id, { name: `RIF${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    const { rows } = await db.query(
      `INSERT INTO fiscal_invoice_requests (restaurant_id, bill_id, idempotency_key, status)
       VALUES ($1, $2, $3, 'ISSUED') RETURNING id, bill_id`,
      [restaurant.id, bill.id, `rif-k-${++seq}`]
    );
    await db.query(
      `INSERT INTO fiscal_invoices
         (restaurant_id, request_id, bill_id, document_number, control_number, provider,
          line_basis, subtotal_minor, vat_minor, service_minor, total_minor, issued_at, document_type)
       VALUES ($1, $2, $3, $4, $5, 'mock', 'AGGREGATE', 1000, 160, 0, 1160, now(), 'INVOICE')`,
      [restaurant.id, rows[0].id, rows[0].bill_id, `F-rif-${++seq}`, `CTRL-rif-${++seq}`]
    );
  };

  beforeEach(async () => {
    await clearIpRateLimits();
    // Cada prueba parte sin nada emitido: el cerrojo se prueba provocándolo a
    // la vista, no heredándolo del orden en que corran los ficheros.
    await fixtures.purgeFiscal(restaurant.id);
    await db.query('UPDATE restaurants SET rif = NULL WHERE id = $1', [restaurant.id]);
  });

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'RIF Tenant' });

    const mint = async (role) => {
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [restaurant.id, `${role.toLowerCase()}-rif-${restaurant.id}@example.com`, role]
      );
      return signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role });
    };
    ownerToken = await mint('OWNER');
    managerToken = await mint('MANAGER');

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await fixtures.purgeFiscal(restaurant.id);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('el dueño lo escribe, y GET /account lo devuelve ya normalizado', async () => {
    const res = await setRif('j-12345678-4');
    assert.equal(res.status, 200);
    assert.equal(res.body.rif, 'J-12345678-4');
    assert.equal(res.body.checksumOk, true);

    // La prueba que de verdad importa: que el hueco que cerramos era éste --
    // antes no había forma de que esto dejara de ser null sin entrar a la base.
    const account = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(account.body.rif, 'J123456784');
  });

  it('un gerente no cambia de contribuyente, aunque pueda renombrar el local', async () => {
    const res = await setRif('J-12345678-4', managerToken);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');

    // Y no lo escribió de todas formas.
    const account = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(account.body.rif, null);
  });

  it('avisa del dígito verificador sin rechazar', async () => {
    // Se guarda igual: rechazar por un cálculo nuestro sin contrastar dejaría
    // sin facturar a un restaurante real. El aviso es la respuesta.
    const res = await setRif('J-12345678-9');
    assert.equal(res.status, 200);
    assert.equal(res.body.checksumOk, false);
    assert.equal(res.body.rif, 'J-12345678-9');
  });

  it('lo que no tiene forma de RIF se rechaza y no se guarda', async () => {
    // Una sola respuesta para toda la familia, corta o larga: si el código
    // cambiara con la longitud del disparate, la pantalla no podría explicarlo.
    for (const bad of ['12345678', 'X123456784', 'hola', '']) {
      const res = await setRif(bad);
      assert.equal(res.status, 400, `«${bad}»`);
      assert.equal(res.body.error.code, 'FISCAL_RIF_MALFORMED', `«${bad}»`);
    }

    const account = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(account.body.rif, null);
  });

  it('deja de poder cambiarse en cuanto se ha emitido', async () => {
    assert.equal((await setRif('J-12345678-4')).status, 200);
    await issueOne();

    const res = await setRif('J-87654321-0');
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'FISCAL_RIF_LOCKED');
    // Dice bajo qué identidad se emitió, que es lo accionable.
    assert.equal(res.body.error.details.issuedRif, 'J-12345678-4');

    const account = await request('GET', '/api/v1/account', null, ownerToken);
    assert.equal(account.body.rif, 'J123456784');
  });

  it('reescribir el mismo RIF después de emitir no es un cambio, y pasa', async () => {
    assert.equal((await setRif('J-12345678-4')).status, 200);
    await issueOne();

    // Guardar el formulario sin tocar el campo no puede dar un error: no hay
    // nada que contradiga lo emitido si el valor es el que ya estaba.
    const res = await setRif('J 12345678 4');
    assert.equal(res.status, 200);
    assert.equal(res.body.rif, 'J-12345678-4');
  });

  it('dos restaurantes no comparten RIF, y se dice con esas palabras', async () => {
    const other = await fixtures.createRestaurant({ name: 'RIF Rival' });
    try {
      await db.query('UPDATE restaurants SET rif = $2 WHERE id = $1', [other.id, 'J555555555']);

      const res = await setRif('J-55555555-5');
      // Un 500 por el índice único sería técnicamente cierto e inútil: casi
      // siempre esto significa que ese contribuyente ya tiene cuenta.
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'FISCAL_RIF_TAKEN');
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
