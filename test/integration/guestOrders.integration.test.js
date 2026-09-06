const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const config = require('../../src/config');

/**
 * Pedir desde la mesa, de extremo a extremo.
 *
 * Sobre HTTP y no sobre el servicio, porque lo que hay que demostrar son
 * propiedades de la ruta: que la mesa la pone la sesión y no el cuerpo, que un
 * comensal de la mesa 1 no puede cargarle nada a la 2, y que lo que ve el panel
 * después es un aviso con lo que se pidió.
 */
describe('guest ordering', { skip }, () => {
  let server;
  let base;
  let restaurant;
  let staffToken;
  let productA;
  let productB;
  let seq = 0;

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

  const tableWithNonce = async (name) => {
    const created = await fixtures.createTable(restaurant.id, { name });
    const { rows } = await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id]);
    return rows[0];
  };

  const scan = async (tableRow) => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      v: 1,
      tableId: tableRow.id,
      restaurantId: tableRow.restaurant_id,
      nonce: tableRow.qr_nonce,
      iat: now,
      ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const res = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // Las dos mitades: el identificador va en su cabecera y el token en
    // Authorization. Con una sola, `authenticateGuest` responde 401.
    return { session: res.body.sessionId, token: res.body.guestToken };
  };

  const product = async (name, price) => {
    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
       VALUES ($1, $2, $3, 'VES', true) RETURNING id`,
      [restaurant.id, name, price]
    );
    return rows[0].id;
  };

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );

  beforeEach(async () => {
    await clearIpRateLimits();
    await db.query('DELETE FROM guest_orders WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM bill_items WHERE restaurant_id = $1', [restaurant.id]);
    await db.query('DELETE FROM bills WHERE restaurant_id = $1', [restaurant.id]);
  });

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Order Tenant' });
    productA = await product('Tequeños', 180000);
    productB = await product('Cachapa', 420000);

    const { hashPassword } = require('../../src/services/auth');
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'OWNER') RETURNING id`,
      [restaurant.id, `order-staff-${restaurant.id}@example.com`, await hashPassword('irrelevant-here-123')]
    );
    staffToken = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await fixtures.destroyRestaurant(restaurant.id);
    }
    await db.close();
    await closeRedis();
  });

  it('opens the bill and puts the lines on it, in one call', async () => {
    // El caso que da sentido a la función: alguien se sienta en una mesa vacía
    // y pide antes de que nadie se acerque. Si esto exigiera una cuenta abierta,
    // el comensal recibiría un error que no puede resolver.
    const table = await tableWithNonce(`O${++seq}`);
    const session = await scan(table);

    const res = await request('POST', '/api/v1/guest/bill/orders', {
      ...session,
      body: { items: [{ productId: productA, quantity: 2 }, { productId: productB, quantity: 1 }] }
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.lineCount, 2);
    assert.ok(res.body.orderId);

    const { rows } = await db.query(
      `SELECT status, subtotal_minor, total_due_ves, served_by
         FROM bills WHERE restaurant_id = $1 AND table_id = $2`,
      [restaurant.id, table.id]
    );
    assert.equal(rows.length, 1, 'abrió exactamente una cuenta');
    assert.equal(rows[0].status, 'OPEN');
    // 2 x 1.800,00 + 1 x 4.200,00
    assert.equal(rows[0].subtotal_minor, '780000');
    assert.equal(rows[0].total_due_ves, '780000');
    assert.equal(rows[0].served_by, null, 'no lo abrió nadie de la casa');
  });

  it('adds to the bill a waiter already opened, without opening a second', async () => {
    const table = await tableWithNonce(`O${++seq}`);
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    const session = await scan(table);

    const res = await request('POST', '/api/v1/guest/bill/orders', {
      ...session, body: { items: [{ productId: productA, quantity: 1 }] }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const { rows } = await db.query(
      "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
      [restaurant.id, table.id]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, bill.id, 'la misma cuenta, no una segunda');
  });

  it('puts the order on the session\'s table, with no way to name another', async () => {
    // La propiedad de seguridad de esta ruta. El cuerpo no tiene `tableId`, así
    // que mandarlo no puede desviar el pedido: `stripUnknown` lo tira. Se afirma
    // el resultado -- la mesa 2 sigue sin cuenta -- y no un 400 que no ocurre.
    const mine = await tableWithNonce(`O${++seq}`);
    const theirs = await tableWithNonce(`O${++seq}`);
    const session = await scan(mine);

    const res = await request('POST', '/api/v1/guest/bill/orders', {
      ...session,
      body: { tableId: theirs.id, items: [{ productId: productA, quantity: 1 }] }
    });
    assert.equal(res.status, 201);

    const theirBills = await db.query(
      'SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2', [restaurant.id, theirs.id]);
    assert.equal(theirBills.rows.length, 0, 'la mesa de al lado no recibió nada');

    const myBills = await db.query(
      'SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2', [restaurant.id, mine.id]);
    assert.equal(myBills.rows.length, 1, 'el pedido fue a la mesa de la sesión');
  });

  it('refuses a product that is no longer on the menu, and writes nothing', async () => {
    const table = await tableWithNonce(`O${++seq}`);
    const session = await scan(table);
    const retired = await product('Retirado', 100000);
    await db.query('UPDATE menu_products SET active = false WHERE id = $1', [retired]);

    const res = await request('POST', '/api/v1/guest/bill/orders', {
      ...session,
      body: { items: [{ productId: productA, quantity: 1 }, { productId: retired, quantity: 1 }] }
    });

    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'PRODUCT_INACTIVE');

    // Y la primera línea tampoco entró: es una transacción, no dos escrituras.
    const orders = await db.query(
      'SELECT id FROM guest_orders WHERE restaurant_id = $1', [restaurant.id]);
    assert.equal(orders.rows.length, 0, 'ni el pedido ni sus líneas');
  });

  it('shows the floor what was ordered, and marks it seen once', async () => {
    const name = `O${++seq}`;
    const table = await tableWithNonce(name);
    const session = await scan(table);
    await request('POST', '/api/v1/guest/bill/orders', {
      ...session, body: { items: [{ productId: productA, quantity: 3 }] }
    });

    const pending = await request('GET', '/api/v1/orders', { token: staffToken });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));
    assert.equal(pending.body.data.length, 1);
    const order = pending.body.data[0];
    assert.equal(order.tableName, name, 'el aviso dice de qué mesa es');
    assert.equal(order.lineCount, 1);
    assert.deepEqual(order.items, [{ name: 'Tequeños', quantity: 3, subtotalMinor: '540000' }]);
    assert.ok(order.ageSeconds !== null && order.ageSeconds >= 0);

    const summary = await request('GET', '/api/v1/orders/summary', { token: staffToken });
    assert.equal(summary.body.pending, 1);

    const ack = await request('POST', `/api/v1/orders/${order.id}/ack`, { token: staffToken });
    assert.equal(ack.status, 200);
    const first = ack.body.acknowledgedAt;
    assert.ok(first);

    // Dos meseros tocando el mismo aviso: el segundo no es un error y no
    // reescribe quién llegó primero.
    const again = await request('POST', `/api/v1/orders/${order.id}/ack`, { token: staffToken });
    assert.equal(again.status, 200);
    assert.equal(again.body.acknowledgedAt, first);

    const tray = await request('GET', '/api/v1/orders', { token: staffToken });
    assert.equal(tray.body.data.length, 0, 'sale de la bandeja');
  });

  it('keeps the count of what was ordered when a waiter removes a line', async () => {
    // `lineCount` y `items` contestan preguntas distintas: qué se pidió y qué
    // queda. Si fueran lo mismo, quitar una línea reescribiría la historia.
    const table = await tableWithNonce(`O${++seq}`);
    const session = await scan(table);
    await request('POST', '/api/v1/guest/bill/orders', {
      ...session, body: { items: [{ productId: productA, quantity: 1 }, { productId: productB, quantity: 1 }] }
    });

    const bill = await db.query(
      "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
      [restaurant.id, table.id]);
    const item = await db.query(
      'SELECT id FROM bill_items WHERE bill_id = $1 AND name_snapshot = $2', [bill.rows[0].id, 'Cachapa']);
    const removed = await request(
      'DELETE', `/api/v1/bills/${bill.rows[0].id}/items/${item.rows[0].id}`, { token: staffToken });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));

    const pending = await request('GET', '/api/v1/orders', { token: staffToken });
    const order = pending.body.data[0];
    assert.equal(order.lineCount, 2, 'se pidieron dos');
    assert.deepEqual(order.items.map(i => i.name), ['Tequeños'], 'queda una');
  });

  it('does not show one restaurant another\'s orders', async () => {
    const table = await tableWithNonce(`O${++seq}`);
    const session = await scan(table);
    await request('POST', '/api/v1/guest/bill/orders', {
      ...session, body: { items: [{ productId: productA, quantity: 1 }] }
    });

    const other = await fixtures.createRestaurant({ name: 'Order Neighbour' });
    try {
      const { hashPassword } = require('../../src/services/auth');
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, $3, 'OWNER') RETURNING id`,
        [other.id, `nb-${other.id}@example.com`, await hashPassword('irrelevant-here-123')]
      );
      const neighbour = signAccessToken({ id: rows[0].id, restaurantId: other.id, role: 'OWNER' });

      const seen = await request('GET', '/api/v1/orders', { token: neighbour });
      assert.equal(seen.body.data.length, 0);

      const mine = await request('GET', '/api/v1/orders', { token: staffToken });
      const stolen = await request('POST', `/api/v1/orders/${mine.body.data[0].id}/ack`, { token: neighbour });
      assert.equal(stolen.status, 404, 'ajeno se lee como ausente, no como prohibido');

      await db.query('DELETE FROM users WHERE restaurant_id = $1', [other.id]);
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('rejects an order bigger than a table can plausibly want', async () => {
    const table = await tableWithNonce(`O${++seq}`);
    const session = await scan(table);

    const res = await request('POST', '/api/v1/guest/bill/orders', {
      ...session, body: { items: [{ productId: productA, quantity: 400 }] }
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });
});
