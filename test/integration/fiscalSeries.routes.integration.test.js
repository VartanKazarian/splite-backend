const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * La serie autorizada, sobre HTTP.
 *
 * Lo que se comprueba aquí no es que el formulario guarde -- eso es lo fácil --
 * sino las dos cosas que lo separan de un formulario cualquiera: quién puede
 * tocarlo, y **qué deja de poderse cambiar en cuanto ha numerado algo**. Esa
 * segunda es la que protege el libro de ventas de acabar con dos formatos.
 */
describe('serie fiscal sobre HTTP', { skip }, () => {
  let server, base, restaurant, ownerToken, managerToken;

  const VALID = {
    controlPrefix: '00-',
    documentPrefix: 'F-',
    padTo: 8,
    controlFirst: 1,
    controlLast: 5000,
    authorisationRef: 'SNAT-2026-000123'
  };

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

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1', 'auth:::ffff:127.0.0.1', 'auth:127.0.0.1'
  );

  beforeEach(async () => {
    await clearIpRateLimits();
    // Cada prueba parte de un restaurante sin serie y sin haber numerado nada,
    // que es lo que deja comprobar el antes y el después del cerrojo sin que el
    // orden de los ficheros decida el resultado.
    await db.query('DELETE FROM fiscal_counters WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM fiscal_series WHERE restaurant_id = $1', [restaurant.id]);
  });

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Series Tenant' });

    const mint = async (role) => {
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', $3) RETURNING id`,
        [restaurant.id, `${role.toLowerCase()}-${restaurant.id}@example.com`, role]
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
      await db.query('DELETE FROM fiscal_counters WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM fiscal_series WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  /** Simula que la serie ya repartió `count` números, sin emitir facturas. */
  const alreadyNumbered = (count) => db.query(
    `INSERT INTO fiscal_counters (restaurant_id, scope, next_value) VALUES ($1, 'CONTROL', $2)`,
    [restaurant.id, String(count + 1)]
  );

  it('sin configurar contesta nulo, no un error', async () => {
    // El panel necesita distinguir «todavía no la has puesto» de «algo se
    // rompió». Un 404 le haría pintar una pantalla de error donde lo que toca
    // es el formulario vacío.
    const res = await request('GET', '/api/v1/account/fiscal-series', null, ownerToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fiscalSeries, null);
  });

  it('el dueño la guarda, y se ve con qué número se va a emitir', async () => {
    const res = await request('PUT', '/api/v1/account/fiscal-series', VALID, ownerToken);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const series = res.body.fiscalSeries;
    assert.equal(series.nextControlNumber, '00-00000001',
      'formateado: es lo que deja comprobar el prefijo y el ancho antes de emitir');
    assert.equal(series.controlLast, '5000');
    assert.equal(series.locked, false, 'todavía no ha numerado nada');

    const read = await request('GET', '/api/v1/account/fiscal-series', null, managerToken);
    assert.deepEqual(read.body.fiscalSeries, series, 'el personal puede consultarla');
  });

  it('un encargado no la escribe', async () => {
    // Transcribe una autorización del SENIAT: es una decisión del dueño, como
    // las de dinero, y no una edición de perfil.
    const res = await request('PUT', '/api/v1/account/fiscal-series', VALID, managerToken);
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('una serie a medias no se guarda', async () => {
    // Guardarla incompleta sólo traslada el fallo al momento de emitir, delante
    // de un comensal que espera su factura.
    const res = await request('PUT', '/api/v1/account/fiscal-series',
      { controlPrefix: '00-', controlFirst: 1 }, ownerToken);
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  it('un tope por debajo del primero se rechaza al entrar', async () => {
    const res = await request('PUT', '/api/v1/account/fiscal-series',
      { ...VALID, controlFirst: 100, controlLast: 99 }, ownerToken);
    assert.equal(res.status, 400, JSON.stringify(res.body));
  });

  it('mientras no haya emitido se puede corregir entera', async () => {
    // El caso normal: se escribió mal y todavía no ha salido ningún documento
    // con ese formato. No hay nada que contradecir.
    await request('PUT', '/api/v1/account/fiscal-series', VALID, ownerToken);
    const res = await request('PUT', '/api/v1/account/fiscal-series',
      { ...VALID, controlPrefix: '01-', padTo: 10, controlFirst: 700 }, ownerToken);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fiscalSeries.nextControlNumber, '01-0000000700');
  });

  it('en cuanto ha numerado, el formato y el primero se congelan', async () => {
    /*
     * La regla que justifica el endpoint aparte.
     *
     * Cambiar el prefijo, el ancho o el primer número después de emitir no
     * cambia la serie de aquí en adelante: **contradice lo ya emitido**. El
     * libro de ventas pasaría a tener dos formatos, y documentos cuyo número no
     * se corresponde con la serie que dice llevarlos.
     */
    await request('PUT', '/api/v1/account/fiscal-series', VALID, ownerToken);
    await alreadyNumbered(3);

    const res = await request('PUT', '/api/v1/account/fiscal-series',
      { ...VALID, controlPrefix: 'X-', padTo: 6 }, ownerToken);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'FISCAL_SERIES_LOCKED');
    assert.deepEqual(res.body.error.details.fields, ['controlPrefix', 'padTo'],
      'dice cuáles, para que el formulario pueda señalarlos');

    const read = await request('GET', '/api/v1/account/fiscal-series', null, ownerToken);
    assert.equal(read.body.fiscalSeries.controlPrefix, '00-', 'y no cambió nada');
    assert.equal(read.body.fiscalSeries.locked, true);
    assert.equal(read.body.fiscalSeries.nextControlNumber, '00-00000004',
      'por dónde va, que es lo que hay que poder mirar');
  });

  it('pero el rango se puede ampliar, que es lo que pasa de verdad', async () => {
    // Llega una autorización nueva. Es el único cambio frecuente, y cerrarlo
    // habría dejado al restaurante sin forma de seguir emitiendo.
    await request('PUT', '/api/v1/account/fiscal-series', VALID, ownerToken);
    await alreadyNumbered(4900);

    const res = await request('PUT', '/api/v1/account/fiscal-series',
      { ...VALID, controlLast: 20000, authorisationRef: 'SNAT-2026-000456' }, ownerToken);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.fiscalSeries.controlLast, '20000');
    assert.equal(res.body.fiscalSeries.authorisationRef, 'SNAT-2026-000456');
  });

  it('bajarlo por debajo de lo ya emitido, no', async () => {
    // Dejaría documentos fuera de su propio rango: emitidos bajo un amparo que
    // la serie ya no dice tener.
    await request('PUT', '/api/v1/account/fiscal-series', VALID, ownerToken);
    await alreadyNumbered(120);

    const res = await request('PUT', '/api/v1/account/fiscal-series',
      { ...VALID, controlLast: 50 }, ownerToken);

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'FISCAL_SERIES_LOCKED');
    assert.equal(res.body.error.details.lastIssued, '120');
  });

  it('queda auditado con qué autorización se emite', async () => {
    // «Quién cambió esto y cuándo» tiene que poder responderse sin leer el diff
    // de una fila, porque la respuesta es parte de lo que se demuestra.
    await request('PUT', '/api/v1/account/fiscal-series', VALID, ownerToken);

    const { rows } = await db.query(
      `SELECT details FROM audit_logs
        WHERE restaurant_id = $1 AND action = 'FISCAL_SERIES_CHANGED'
        ORDER BY created_at DESC LIMIT 1`,
      [restaurant.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].details.authorisationRef, 'SNAT-2026-000123');
    assert.equal(rows[0].details.controlFirst, '1');
    assert.equal(rows[0].details.controlLast, '5000');
  });
});
