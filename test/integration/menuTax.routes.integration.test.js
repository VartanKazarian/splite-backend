const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * La fiscalidad de la carta, sobre HTTP.
 *
 * Las pruebas de `billItemTax` llaman al servicio directamente, así que fijan
 * el cálculo y no el contrato: una ruta podría dejar de seleccionar
 * `tax_category` y todas seguirían en verde mientras la API devuelve TAXABLE
 * para un producto exento. Estas conducen la superficie de verdad, que es
 * donde se editó una lista de columnas por cada sitio en el que se lee un
 * producto.
 */
describe('fiscalidad de la carta sobre HTTP', { skip }, () => {
  let server, base, restaurant, token;
  let seq = 0;

  const request = async (method, path, body) => {
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

  // Cada petición sale de 127.0.0.1 contra un límite por IP. El límite es
  // correcto; lo que comparte dirección es el banco de pruebas.
  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1'
  );
  beforeEach(clearIpRateLimits);

  const newProduct = (body) =>
    request('POST', '/api/v1/menu/products', { name: `P${++seq}`, priceMinorUnits: '1000', ...body });

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Tax Routes Tenant' });
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
      [restaurant.id, `tax-routes-${restaurant.id}@example.com`]
    );
    token = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('un producto nuevo sale gravado, sin que nadie lo diga', async () => {
    const res = await newProduct({});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.taxCategory, 'TAXABLE', 'el defecto es lo que era todo hasta ahora');
    assert.equal(res.body.vatBps, null, 'sigue la general del restaurante');
  });

  it('acepta una categoría y una alícuota propia, y las devuelve al leer', async () => {
    const created = await newProduct({ taxCategory: 'TAXABLE', vatBps: 800 });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.vatBps, 800);

    // El listado es otra consulta, con su propia lista de columnas: si sólo se
    // hubiera arreglado el RETURNING del alta, esto se caería.
    const list = await request('GET', '/api/v1/menu/products?limit=100');
    assert.equal(list.status, 200);
    const mine = list.body.data.find(p => p.id === created.body.id);
    assert.ok(mine, 'el producto recién creado debería estar en el listado');
    assert.equal(mine.taxCategory, 'TAXABLE');
    assert.equal(mine.vatBps, 800);
  });

  it('rechaza un exento con alícuota propia, diciendo cuál de los dos sobra', async () => {
    const res = await newProduct({ taxCategory: 'EXEMPT', vatBps: 1600 });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
    assert.ok(
      res.body.error.details.fieldPaths.includes('vatBps'),
      'el formulario tiene que poder marcar la casilla que sobra'
    );
  });

  it('rechaza una categoría fiscal inventada', async () => {
    const res = await newProduct({ taxCategory: 'SIN_IVA' });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.fieldPaths.includes('taxCategory'));
  });

  it('declarar exento un producto con alícuota propia se la quita', async () => {
    const created = await newProduct({ vatBps: 800 });
    assert.equal(created.body.vatBps, 800);

    // Sin limpiarla saltaría el CHECK de la base. Y limpiarla es lo que el
    // cambio significa: un exento no tiene alícuota que aplicar.
    const patched = await request('PATCH', `/api/v1/menu/products/${created.body.id}`,
      { taxCategory: 'EXEMPT' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.taxCategory, 'EXEMPT');
    assert.equal(patched.body.vatBps, null);
  });

  it('ponerle alícuota a uno que ya estaba exento se rechaza con un motivo', async () => {
    const created = await newProduct({ taxCategory: 'EXEMPT' });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // El esquema no puede atraparlo: sólo llega `vatBps`, y la categoría que lo
    // contradice es la guardada. Lo ve la base, y lo que no puede es salir en
    // crudo -- un 23514 no le dice a nadie qué hacer.
    const patched = await request('PATCH', `/api/v1/menu/products/${created.body.id}`,
      { vatBps: 1600 });
    assert.equal(patched.status, 409, JSON.stringify(patched.body));
    assert.equal(patched.body.error.code, 'PRODUCT_TAX_CONFLICT');
    assert.match(patched.body.error.message, /taxCategory/);
  });

  it('cambiar categoría y alícuota a la vez sí vale', async () => {
    const created = await newProduct({ taxCategory: 'EXEMPT' });
    const patched = await request('PATCH', `/api/v1/menu/products/${created.body.id}`,
      { taxCategory: 'TAXABLE', vatBps: 1600 });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.taxCategory, 'TAXABLE');
    assert.equal(patched.body.vatBps, 1600);
  });

  it('devolver un producto a la alícuota general es mandar null, no omitir', async () => {
    const created = await newProduct({ vatBps: 800 });
    const patched = await request('PATCH', `/api/v1/menu/products/${created.body.id}`,
      { vatBps: null });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal(patched.body.vatBps, null);

    // Y omitirlo lo deja donde estaba: son cosas distintas.
    const again = await newProduct({ vatBps: 800 });
    const renamed = await request('PATCH', `/api/v1/menu/products/${again.body.id}`,
      { name: `Renombrado${++seq}` });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.vatBps, 800, 'un cambio de nombre no toca el impuesto');
  });

  it('la cuenta publica el impuesto de cada línea', async () => {
    const gravado = await newProduct({});
    const exento = await newProduct({ taxCategory: 'EXEMPT' });

    const table = await fixtures.createTable(restaurant.id, { name: `HT${++seq}` });
    const bill = await request('POST', '/api/v1/bills',
      { tableId: table.id, totalDueMinorUnits: '0' });
    assert.equal(bill.status, 201, JSON.stringify(bill.body));

    for (const id of [gravado.body.id, exento.body.id]) {
      const added = await request('POST', `/api/v1/bills/${bill.body.id}/items`,
        { productId: id, quantity: 1 });
      assert.equal(added.status, 201, JSON.stringify(added.body));
    }

    const read = await request('GET', `/api/v1/bills/${bill.body.id}`);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const byCategory = Object.fromEntries(read.body.items.map(i => [i.taxCategory, i.vatBps]));
    assert.deepEqual(Object.keys(byCategory).sort(), ['EXEMPT', 'TAXABLE']);
    assert.equal(byCategory.EXEMPT, 0, 'un exento paga cero, y lo dice');
  });
});
