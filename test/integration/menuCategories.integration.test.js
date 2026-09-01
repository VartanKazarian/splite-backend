const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');

/**
 * Sections a restaurant maintains by hand, and the menu file it uploads.
 *
 * Over HTTP rather than against the service, because most of what is worth
 * asserting here lives in the request path: the role gate, the unique-name
 * collision surfacing as 409 rather than 500, the reorder rolling back, and a
 * public route that must answer a caller holding no credentials at all.
 */
describe('menu sections and the uploaded menu', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let other;
  let token;

  const api = async (method, path, { body, auth = true, raw = false } = {}) => {
    const headers = {};
    if (auth) headers.authorization = `Bearer ${token}`;
    if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) })
    });
    if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // The smallest thing that is genuinely a PDF: the header is what the route
  // checks, so a fixture without one would pass for the wrong reason.
  const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');
  const filePart = (bytes, name = 'carta.pdf', type = 'application/pdf') => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), name);
    return form;
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Sections Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Sections Tenant' });

    const argon2 = require('argon2');
    const hash = await argon2.hash('Sup3rSecret!23');
    await db.query(
      'INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1,$2,$3,$4)',
      [restaurant.id, 'sections-owner@example.com', hash, 'OWNER']
    );

    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const login = await api('POST', '/api/v1/auth/login', {
      body: { email: 'sections-owner@example.com', password: 'Sup3rSecret!23' },
      auth: false
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    token = login.body.accessToken;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const r of [restaurant, other]) {
      if (!r) continue;
      await db.query('DELETE FROM menu_documents WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM menu_categories WHERE restaurant_id = $1', [r.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [r.id]);
      await fixtures.destroyRestaurant(r.id);
    }
    await closeRedis();
    await db.close();
  });

  it('files a new section at the end rather than the front', async () => {
    // Defaulting position to 0 would put every new section first and leave the
    // name tie-break deciding the order.
    const first = await api('POST', '/api/v1/menu/categories', { body: { name: 'Entradas' } });
    const second = await api('POST', '/api/v1/menu/categories', { body: { name: 'Principales' } });

    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body.position, 0);
    assert.equal(second.body.position, 1);
  });

  it('refuses a duplicate name with 409, not 500', async () => {
    const again = await api('POST', '/api/v1/menu/categories', { body: { name: 'Entradas' } });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'CATEGORY_NAME_TAKEN');
    assert.equal(again.body.error.details.name, 'Entradas');
  });

  it('reorders from the array, zero-based', async () => {
    const list = await api('GET', '/api/v1/menu/categories');
    const ids = list.body.data.map(c => c.id);

    const res = await api('PUT', '/api/v1/menu/categories/order', { body: { ids: [...ids].reverse() } });
    assert.equal(res.status, 204);

    const after = await api('GET', '/api/v1/menu/categories');
    assert.deepEqual(after.body.data.map(c => c.position), [0, 1]);
    assert.deepEqual(after.body.data.map(c => c.id), [...ids].reverse());
  });

  it('rolls a partial reorder back rather than half applying it', async () => {
    // The UPDATE matches only this tenant's rows, so without the transaction
    // the real ids would be reordered and the request answered 404 anyway.
    const before = await api('GET', '/api/v1/menu/categories');
    const ids = before.body.data.map(c => c.id);

    const res = await api('PUT', '/api/v1/menu/categories/order', {
      body: { ids: [ids[1], ids[0], '11111111-2222-4333-8444-555555555555'] }
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'CATEGORY_NOT_FOUND');

    const after = await api('GET', '/api/v1/menu/categories');
    assert.deepEqual(after.body.data.map(c => c.id), ids, 'nothing may have moved');
  });

  it('will not rename another restaurant\'s section', async () => {
    const { rows } = await db.query(
      `INSERT INTO menu_categories (restaurant_id, name, position) VALUES ($1,'Ajena',0) RETURNING id`,
      [other.id]
    );
    const res = await api('PATCH', `/api/v1/menu/categories/${rows[0].id}`, { body: { name: 'Secuestrada' } });

    assert.equal(res.status, 404);
    const still = await db.query('SELECT name FROM menu_categories WHERE id = $1', [rows[0].id]);
    assert.equal(still.rows[0].name, 'Ajena', 'the other tenant\'s section is untouched');
  });

  it('deleting a section keeps its food, uncategorised', async () => {
    const list = await api('GET', '/api/v1/menu/categories');
    const target = list.body.data[0];
    const product = await api('POST', '/api/v1/menu/products', {
      body: { name: 'Tequeños', priceMinorUnits: '450000', categoryId: target.id }
    });
    assert.equal(product.status, 201);

    const res = await api('DELETE', `/api/v1/menu/categories/${target.id}`);
    assert.equal(res.status, 204);

    const { rows } = await db.query(
      'SELECT category_id, active, restaurant_id FROM menu_products WHERE id = $1',
      [product.body.id]
    );
    assert.equal(rows.length, 1, 'the product survives its section');
    assert.equal(rows[0].category_id, null);
    assert.equal(rows[0].active, true, 'and is still sellable');
    // The composite FK nulls the named column only; blanking restaurant_id
    // would take the tenant off the product.
    assert.equal(rows[0].restaurant_id, restaurant.id);
  });

  it('stores an uploaded menu and serves the same bytes publicly', async () => {
    const up = await api('PUT', '/api/v1/menu/pdf', { body: filePart(pdfBytes) });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.sizeBytes, pdfBytes.length);
    assert.equal(up.body.filename, 'carta.pdf');

    const got = await api('GET', `/api/v1/menu/public/${restaurant.id}/pdf`, { auth: false, raw: true });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/pdf');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(got.buffer.equals(pdfBytes), 'the diner gets the file that was uploaded');
  });

  it('refuses something that is not a PDF however it is labelled', async () => {
    const res = await api('PUT', '/api/v1/menu/pdf', {
      body: filePart(Buffer.from('GIF89a this is an image'), 'carta.pdf', 'application/pdf')
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'MENU_PDF_UNSUPPORTED_MEDIA');
  });

  it('advertises the file on the public menu without sending it', async () => {
    const res = await api('GET', `/api/v1/menu/public/${restaurant.id}/products`, { auth: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.menuPdf.sizeBytes, pdfBytes.length);
    assert.equal(res.body.menuPdf.url, `/api/v1/menu/public/${restaurant.id}/pdf`);
    // The bytes must not ride along in the JSON.
    assert.ok(!JSON.stringify(res.body).includes('%PDF'), 'the file itself stays on its own route');
  });

  it('removing the file leaves the structured menu alone', async () => {
    const productsBefore = await api('GET', '/api/v1/menu/products');

    assert.equal((await api('DELETE', '/api/v1/menu/pdf')).status, 204);
    assert.equal((await api('GET', '/api/v1/menu/pdf')).status, 404);
    assert.equal(
      (await api('GET', `/api/v1/menu/public/${restaurant.id}/pdf`, { auth: false })).status, 404);

    const productsAfter = await api('GET', '/api/v1/menu/products');
    assert.equal(productsAfter.body.data.length, productsBefore.body.data.length);
  });

  it('needs a credential for every write', async () => {
    const anonymous = [
      await api('POST', '/api/v1/menu/categories', { body: { name: 'X' }, auth: false }),
      await api('PUT', '/api/v1/menu/categories/order', { body: { ids: [restaurant.id] }, auth: false }),
      await api('PUT', '/api/v1/menu/pdf', { body: filePart(pdfBytes), auth: false })
    ];
    for (const res of anonymous) assert.equal(res.status, 401);
  });
});
