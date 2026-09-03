const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');

/**
 * What a diner actually sees, over HTTP against a real Postgres.
 *
 * Two things the restaurant controls and could not previously change: the name
 * above the table number on the landing page, and whether a dish has a
 * photograph. They are tested together because they are one surface -- the
 * phone in the hand of somebody who has just scanned the code on the table.
 *
 * The parts worth proving are the ones a unit test cannot see: that the bytes
 * survive a round trip through bytea intact, that a menu listing reports a
 * photo without carrying it, that the URL changes when the picture does -- the
 * thing standing between a restaurant and a phone showing last season's dish
 * forever -- and that a product from another tenant is a 404 rather than a
 * picture.
 */
describe('what a diner sees: the restaurant name and its dish photos', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let other;
  let token;
  let seq = 0;

  // The smallest real files of each kind. Written out rather than generated so
  // the signature checks in the route are exercised by actual headers.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const JPEG = Buffer.concat([
    Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
    Buffer.alloc(64, 0x7f),
    Buffer.from('ffd9', 'hex')
  ]);

  const request = async (method, path, { body, form, auth = true, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: form ?? (body ? JSON.stringify(body) : undefined)
    });
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('application/json')) {
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
    }
    return {
      status: res.status,
      headers: res.headers,
      bytes: Buffer.from(await res.arrayBuffer())
    };
  };

  const upload = (productId, bytes, { type = 'image/png', filename = 'dish.png' } = {}) => {
    const form = new FormData();
    form.append('file', new Blob([bytes], { type }), filename);
    return request('PUT', `/api/v1/menu/products/${productId}/image`, { form });
  };

  const newProduct = async (restaurantId = restaurant.id) => {
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
       VALUES ($1, $2, '10000', 'VES', true) RETURNING id`,
      [restaurantId, `Dish ${++seq}-${Math.random().toString(36).slice(2, 8)}`]
    );
    return rows[0].id;
  };

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'auth:::ffff:127.0.0.1', 'auth:127.0.0.1',
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );

  beforeEach(clearIpRateLimits);

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Photos Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Photos Tenant' });

    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
      [restaurant.id, `photos-${restaurant.id}@example.com`]
    );
    token = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await fixtures.destroyRestaurant(other?.id);
    await db.close();
    await closeRedis();
  });

  it('stores a photo and serves the same bytes back to a diner', async () => {
    const productId = await newProduct();

    const put = await upload(productId, PNG);
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.ok(put.body.imageUrl, 'the product comes back with its photo');

    // Unauthenticated, as a phone at the table would.
    const got = await request('GET', put.body.imageUrl, { auth: false });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.deepEqual(got.bytes, PNG, 'the bytes survived the round trip through bytea');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');

    // The panel and the API are different sites in every deployment we have,
    // so the app-wide `same-site` policy has to be overridden here or the
    // browser fetches the photo and then refuses to render it. It fails as a
    // blocked subresource rather than an HTTP error, which is why only a real
    // browser catches it -- this line is what stops it coming back.
    assert.equal(got.headers.get('cross-origin-resource-policy'), 'cross-origin');
  });

  it('changes the URL when the photo is replaced', async () => {
    // Without this a phone that cached the first picture keeps showing it, and
    // the restaurant's only recourse is telling diners to clear their browser.
    const productId = await newProduct();
    const first = await upload(productId, PNG);
    const second = await upload(productId, JPEG, { type: 'image/jpeg', filename: 'dish.jpg' });

    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.notEqual(second.body.imageUrl, first.body.imageUrl, 'a new picture is a new address');

    const got = await request('GET', second.body.imageUrl, { auth: false });
    assert.equal(got.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(got.bytes, JPEG);

    // One row, not two: the upsert replaced rather than accumulated.
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM menu_product_images WHERE product_id = $1', [productId]
    );
    assert.equal(rows[0].n, 1);
  });

  it('answers a phone that already has the photo with 304 and no body', async () => {
    const productId = await newProduct();
    const put = await upload(productId, PNG);

    const first = await request('GET', put.body.imageUrl, { auth: false });
    const etag = first.headers.get('etag');
    assert.ok(etag, 'an ETag is sent');

    const again = await request('GET', put.body.imageUrl, {
      auth: false, headers: { 'if-none-match': etag }
    });
    assert.equal(again.status, 304);
    assert.equal(again.bytes.length, 0, 'the file is not sent a second time');
  });

  it('reports the photo on the public menu without carrying the bytes', async () => {
    // The query a diner's phone makes. A menu that shipped the files inline
    // would be megabytes before a single dish appeared.
    const productId = await newProduct();
    await upload(productId, PNG);

    const menu = await request('GET', `/api/v1/menu/public/${restaurant.id}/products`, { auth: false });
    assert.equal(menu.status, 200);

    const listed = menu.body.products.find(p => p.id === productId);
    assert.ok(listed.imageUrl, 'the diner is told there is a photo');
    assert.equal(
      JSON.stringify(menu.body).includes('iVBORw0KGgo'), false,
      'and is not sent the file inside the listing'
    );

    // A dish with no photo, made here rather than picked out of the listing:
    // the other tests in this suite share the tenant and have given theirs one.
    const bare = await newProduct();
    const reread = await request('GET', `/api/v1/menu/public/${restaurant.id}/products`, { auth: false });
    const listedBare = reread.body.products.find(p => p.id === bare);
    assert.equal(listedBare.imageUrl, null, 'no photo is null, not a broken link');
  });

  it('refuses a file that is not the picture it claims to be', async () => {
    const productId = await newProduct();
    const notAnImage = Buffer.from('%PDF-1.7\nthis is a menu, not a dish\n');

    const put = await upload(productId, notAnImage, { type: 'image/png' });
    assert.equal(put.status, 400);
    assert.equal(put.body.error.code, 'PRODUCT_IMAGE_UNSUPPORTED_MEDIA');

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM menu_product_images WHERE product_id = $1', [productId]
    );
    assert.equal(rows[0].n, 0, 'nothing was stored');
  });

  it('will not serve a photo under the wrong restaurant', async () => {
    // The route is public and takes both ids from the path. A product id from
    // another tenant must be a 404 rather than a picture, whatever else is true.
    const productId = await newProduct();
    await upload(productId, PNG);

    const crossed = await request(
      'GET', `/api/v1/menu/public/${other.id}/products/${productId}/image`, { auth: false }
    );
    assert.equal(crossed.status, 404);
  });

  it('hides the photo of a deactivated product', async () => {
    const productId = await newProduct();
    await upload(productId, PNG);
    await db.query('UPDATE menu_products SET active = false WHERE id = $1', [productId]);

    const got = await request(
      'GET', `/api/v1/menu/public/${restaurant.id}/products/${productId}/image`, { auth: false }
    );
    assert.equal(got.status, 404, 'a product off the menu takes its picture with it');
  });

  it('removes a photo and leaves the product alone', async () => {
    const productId = await newProduct();
    await upload(productId, PNG);

    const removed = await request('DELETE', `/api/v1/menu/products/${productId}/image`);
    assert.equal(removed.status, 204);

    const again = await request('DELETE', `/api/v1/menu/products/${productId}/image`);
    assert.equal(again.status, 404, 'and says so if there was nothing to remove');

    const { rows } = await db.query('SELECT id FROM menu_products WHERE id = $1', [productId]);
    assert.equal(rows.length, 1, 'the dish is still on the menu');
  });

  it('takes the photo with the product when the product is deleted', async () => {
    // ON DELETE CASCADE, checked rather than assumed: an orphaned megabyte per
    // deleted dish is a table that only grows.
    const productId = await newProduct();
    await upload(productId, PNG);

    await request('DELETE', `/api/v1/menu/products/${productId}?permanent=true`);

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM menu_product_images WHERE product_id = $1', [productId]
    );
    assert.equal(rows[0].n, 0);
  });

  it('lets the restaurant rename itself, which is what the QR landing page shows', async () => {
    // The name a diner reads above the table number. It could only be set
    // during onboarding, which left whatever was typed that day -- "Splite
    // Demo" -- in front of every customer with nothing able to correct it.
    const renamed = await request('PATCH', '/api/v1/account', { body: { name: 'Casa 72' } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.name, 'Casa 72');

    // Read back through the public menu, which is the surface a phone sees.
    const menu = await request('GET', `/api/v1/menu/public/${restaurant.id}/products`, { auth: false });
    assert.equal(menu.body.restaurant.name, 'Casa 72');

    // Trimmed, and never blanked into an empty landing page.
    const padded = await request('PATCH', '/api/v1/account', { body: { name: '  Casa 72  ' } });
    assert.equal(padded.body.name, 'Casa 72');

    const blank = await request('PATCH', '/api/v1/account', { body: { name: '   ' } });
    assert.equal(blank.status, 400);
  });

  it('keeps the stored size and checksum true to the bytes', async () => {
    // Both are denormalised so that a listing and a 304 never have to read the
    // file. The database enforces the size; this proves the checksum too.
    const productId = await newProduct();
    await upload(productId, PNG);

    const { rows } = await db.query(
      'SELECT size_bytes, checksum, octet_length(bytes) AS actual FROM menu_product_images WHERE product_id = $1',
      [productId]
    );
    assert.equal(rows[0].size_bytes, PNG.length);
    assert.equal(rows[0].actual, PNG.length);
    assert.equal(rows[0].checksum, crypto.createHash('sha256').update(PNG).digest('hex'));
  });
});
