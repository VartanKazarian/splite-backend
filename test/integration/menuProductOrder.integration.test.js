const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/utils/tokens');

/**
 * El orden de los platos dentro de una sección.
 *
 * Antes todos los productos nacían en la posición 0 y la carta salía por orden
 * alfabético sin manera de cambiarlo. Lo que se prueba: que un plato nuevo o
 * movido cae al final de su sección, que el orden se guarda entero o no se
 * guarda, y que no se puede tocar el de otro restaurante.
 */
describe('product order within a section', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let other;
  let owner;
  let waiter;

  const api = async (method, path, { body, token = owner } = {}) => {
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const mintUser = async (r, role) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [r.id, `order-${role.toLowerCase()}-${r.id}@example.com`, role]
    );
    return signAccessToken({ id: rows[0].id, restaurantId: r.id, role });
  };

  const section = async name => (await api('POST', '/api/v1/menu/categories', { body: { name } })).body;
  const product = async (name, categoryId, token = owner) => {
    const res = await api('POST', '/api/v1/menu/products', {
      body: { name, priceMinorUnits: '500', ...(categoryId === undefined ? {} : { categoryId }) },
      token
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body;
  };
  const namesIn = async categoryId => {
    const q = categoryId === null ? 'none' : categoryId;
    const res = await api('GET', `/api/v1/menu/products?categoryId=${q}&limit=100`);
    assert.equal(res.status, 200);
    return res.body.data.map(p => p.name);
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: `Order ${Date.now()}` });
    other = await fixtures.createRestaurant({ name: `Order other ${Date.now()}` });
    owner = await mintUser(restaurant, 'OWNER');
    waiter = await mintUser(restaurant, 'WAITER');
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const r of [restaurant, other]) {
      if (!r) continue;
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM menu_categories WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [r.id]);
      await fixtures.destroyRestaurant(r.id);
    }
    await db.close();
    await closeRedis();
  });

  it('un plato nuevo va al final de su sección, no a su puesto alfabético', async () => {
    const drinks = await section('Bebidas orden');
    await product('Zumo', drinks.id);
    await product('Agua', drinks.id);
    assert.deepEqual(await namesIn(drinks.id), ['Zumo', 'Agua']);
  });

  it('guarda el orden que llega, entero', async () => {
    const mains = await section('Principales orden');
    const a = await product('Asado', mains.id);
    const b = await product('Bistec', mains.id);
    const c = await product('Cachapa', mains.id);

    const res = await api('PUT', '/api/v1/menu/products/order', { body: { categoryId: mains.id, ids: [c.id, a.id, b.id] } });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.deepEqual(await namesIn(mains.id), ['Cachapa', 'Asado', 'Bistec']);

    // La carta pública lee el mismo orden.
    const { rows } = await db.query(
      'SELECT name FROM menu_products WHERE category_id = $1 ORDER BY position, name',
      [mains.id]
    );
    assert.deepEqual(rows.map(r => r.name), ['Cachapa', 'Asado', 'Bistec']);
  });

  it('una lista incompleta o mezclada no cambia nada', async () => {
    const starters = await section('Entradas orden');
    const other1 = await section('Postres orden');
    const x = await product('Tequeños', starters.id);
    const y = await product('Pastelitos', starters.id);
    const z = await product('Quesillo', other1.id);
    const unchanged = await namesIn(starters.id);

    const missing = await api('PUT', '/api/v1/menu/products/order', { body: { categoryId: starters.id, ids: [y.id] } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'PRODUCT_NOT_FOUND');

    const foreignSection = await api('PUT', '/api/v1/menu/products/order', {
      body: { categoryId: starters.id, ids: [y.id, x.id, z.id] }
    });
    assert.equal(foreignSection.status, 404);
    assert.deepEqual(await namesIn(starters.id), unchanged);
  });

  it('no deja ordenar con platos de otro restaurante', async () => {
    const mine = await section('Mías orden');
    const p = await product('Arepa', mine.id);
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency)
       VALUES ($1, 'Ajena', 100, 'USD') RETURNING id`,
      [other.id]
    );
    const res = await api('PUT', '/api/v1/menu/products/order', { body: { categoryId: mine.id, ids: [rows[0].id, p.id] } });
    assert.equal(res.status, 404);
  });

  it('ordena también los que no tienen sección', async () => {
    const n1 = await product('Sin sección B', null);
    const n2 = await product('Sin sección A', null);
    const ids = (await api('GET', '/api/v1/menu/products?categoryId=none&limit=100')).body.data.map(p => p.id);
    assert.deepEqual(ids.slice(-2), [n1.id, n2.id]);
    const reversed = [...ids].reverse();
    const res = await api('PUT', '/api/v1/menu/products/order', { body: { categoryId: null, ids: reversed } });
    assert.equal(res.status, 204);
    const reordered = (await api('GET', '/api/v1/menu/products?categoryId=none&limit=100')).body.data.map(p => p.id);
    assert.deepEqual(reordered, reversed);
  });

  it('cambiar de sección lo manda al final de la nueva', async () => {
    const from = await section('Origen orden');
    const to = await section('Destino orden');
    await product('Primero', to.id);
    await product('Segundo', to.id);
    const moving = await product('Mudanza', from.id);
    const res = await api('PATCH', `/api/v1/menu/products/${moving.id}`, { body: { categoryId: to.id } });
    assert.equal(res.status, 200);
    assert.deepEqual(await namesIn(to.id), ['Primero', 'Segundo', 'Mudanza']);

    // Cambiar otra cosa no lo mueve.
    await api('PUT', '/api/v1/menu/products/order', {
      body: { categoryId: to.id, ids: (await api('GET', `/api/v1/menu/products?categoryId=${to.id}`)).body.data.map(p => p.id).reverse() }
    });
    await api('PATCH', `/api/v1/menu/products/${moving.id}`, { body: { priceMinorUnits: '900', categoryId: to.id } });
    assert.deepEqual(await namesIn(to.id), ['Mudanza', 'Segundo', 'Primero']);
  });

  it('un mesero no puede reordenar', async () => {
    const s = await section('Mesero orden');
    const p = await product('Algo', s.id);
    const res = await api('PUT', '/api/v1/menu/products/order', { body: { categoryId: s.id, ids: [p.id] }, token: waiter });
    assert.equal(res.status, 403);
  });
});
