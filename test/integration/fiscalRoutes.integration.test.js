const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const config = require('../../src/config');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signQrPayload, signAccessToken } = require('../../src/utils/tokens');
const providers = require('../../src/fiscal/providers');
const { createMockProvider } = require('../../src/fiscal/providers/mock');
const billItems = require('../../src/services/billItems');
const app = require('../../src/app');

/**
 * Pedir factura y consultarla, sobre HTTP.
 *
 * Dos cosas se persiguen aquí por encima del camino feliz. Que **consumidor
 * final** sea una petición completa y no un formulario a medio llenar, porque
 * es el caso mayoritario. Y que la lectura de un documento ya emitido no la
 * cierre nunca el plan: el deber de conservarlo sobrevive a la suscripción.
 */
describe('facturación sobre HTTP', { skip }, () => {
  let server, base, restaurant, staffToken, table, mock;
  let seq = 0;

  const request = async (method, path, { body, token, session } = {}) => {
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
  beforeEach(async () => {
    await clearIpRateLimits();
    mock = createMockProvider();
    providers.register('mock', mock);
  });

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Fiscal Routes Tenant' });
    await db.query(
      `UPDATE restaurants SET vat_bps = 1600, service_charge_bps = 1000, plan_tier = 'ENTERPRISE'
        WHERE id = $1`, [restaurant.id]
    );
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
      [restaurant.id, `fiscal-${restaurant.id}@example.com`]
    );
    staffToken = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });

    const created = await fixtures.createTable(restaurant.id, { name: 'FR1' });
    const t = await db.query('SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id]);
    table = t.rows[0];

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (restaurant) {
      for (const t of ['fiscal_invoice_lines', 'fiscal_invoice_taxes', 'fiscal_invoices']) {
        await db.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_immutable`);
      }
      await db.query('DELETE FROM fiscal_invoice_lines WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM fiscal_invoice_taxes WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM fiscal_invoices WHERE restaurant_id = $1', [restaurant.id]);
      for (const t of ['fiscal_invoice_lines', 'fiscal_invoice_taxes', 'fiscal_invoices']) {
        await db.query(`ALTER TABLE ${t} ENABLE TRIGGER ${t}_immutable`);
      }
      await db.query('DELETE FROM fiscal_invoice_requests WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const scan = async () => {
    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      tableId: table.id, restaurantId: restaurant.id, nonce: table.qr_nonce,
      iat: now, ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const res = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return { session: res.body.sessionId, token: res.body.guestToken };
  };

  /** Una cuenta abierta en la mesa del QR, con una línea gravada. */
  async function billWithPayment(amount = 12600) {
    await db.query(`UPDATE bills SET status = 'CLOSED' WHERE table_id = $1 AND status = 'OPEN'`, [table.id]);
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 1000 WHERE id = $1', [bill.id]);

    const { rows } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, 10000, 'VES', true, 'TAXABLE') RETURNING id`,
      [restaurant.id, `Plato-${++seq}`]
    );
    await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: rows[0].id, quantity: 1
    });

    const pay = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'GUEST', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, bill.id, amount]
    );
    return { billId: bill.id, paymentId: pay.rows[0].id };
  }

  it('consumidor final: sólo el paymentId es una petición completa', async () => {
    /*
     * La afirmación más importante de este fichero.
     *
     * La mayoría no da su cédula por una cena. Si el cuerpo mínimo no bastara,
     * el caso mayoritario sería el caso raro y el recorrido acabaría en un
     * formulario que casi nadie quiere rellenar.
     */
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();

    const res = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ISSUED');
    assert.equal(res.body.invoice.customer, null, 'sin receptor es consumidor final, no un hueco');
    assert.equal(res.body.paymentUnaffected, true);
  });

  it('pedirla dos veces lo dice; no revienta ni emite un segundo documento', async () => {
    /*
     * Dos pulsaciones seguidas, o una red que se cortó y un reintento.
     *
     * El índice único ya impedía el segundo documento, y eso no cambia. Lo que
     * cambia es cómo se cuenta: el choque salía en crudo como 500
     * INTERNAL_ERROR, y un cliente que sólo ve «error interno» no puede
     * decirle al comensal lo único que hay que decirle -- que su factura ya
     * está pedida. Medido contra el código anterior: la segunda y la tercera
     * devolvían 500.
     *
     * Se usa un pago **parcial** a propósito: con la cuenta entera pagada el
     * segundo intento choca antes, contra FISCAL_NOTHING_TO_DECLARE, y el
     * camino que este arreglo cubre no llegaría a recorrerse.
     */
    const { paymentId } = await billWithPayment(3000);
    const { session, token } = await scan();

    const first = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    for (const attempt of ['segunda', 'tercera']) {
      const again = await request('POST', '/api/v1/guest/bill/invoice', {
        body: { paymentId }, token, session
      });
      assert.equal(again.status, 409, `${attempt}: ${JSON.stringify(again.body)}`);
      assert.equal(again.body.error.code, 'FISCAL_ALREADY_REQUESTED');
    }

    // Y lo que de verdad importa: un cobro, un documento.
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM fiscal_invoices WHERE payment_id = $1', [paymentId]
    );
    assert.equal(rows[0].n, 1, 'un cobro no puede acabar con dos facturas');
  });

  it('quien da su cédula la recibe en el documento', async () => {
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();

    const res = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId, name: 'Ana Pérez', taxId: 'V12345678', email: 'ana@example.com' },
      token, session
    });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.invoice.customer.taxId, 'V12345678');
    assert.equal(res.body.invoice.customer.name, 'Ana Pérez');
  });

  it('un RIF mal escrito se rechaza, porque quien lo da lo necesita exacto', async () => {
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();

    const res = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId, taxId: 'NO-ES-UN-RIF' }, token, session
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details.fieldPaths.includes('taxId'));
  });

  it('una duda contesta 202 y no promete una factura que no existe', async () => {
    // 201 diría «creado». No se ha creado nada, y puede que nunca se cree.
    const { paymentId } = await billWithPayment();
    providers.register('mock', {
      issue: async () => { throw Object.assign(new Error('t'), { status: 504 }); },
      lookup: async () => { throw Object.assign(new Error('t'), { status: 504 }); }
    });
    const { session, token } = await scan();

    const res = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });

    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.status, 'UNCERTAIN');
    assert.equal(res.body.invoice, null);
    assert.equal(res.body.paymentUnaffected, true, 'el cobro sigue en pie: eso hay que decirlo');
  });

  it('un plan sin facturación lo dice, y dice cuál la tiene', async () => {
    await db.query(`UPDATE restaurants SET plan_tier = 'PRO' WHERE id = $1`, [restaurant.id]);
    try {
      const { paymentId } = await billWithPayment();
      const { session, token } = await scan();
      const res = await request('POST', '/api/v1/guest/bill/invoice', {
        body: { paymentId }, token, session
      });

      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.code, 'PLAN_UPGRADE_REQUIRED');
      assert.deepEqual(res.body.error.details.requiredTiers, ['ENTERPRISE']);
    } finally {
      await db.query(`UPDATE restaurants SET plan_tier = 'ENTERPRISE' WHERE id = $1`, [restaurant.id]);
    }
  });

  it('se puede facturar DESPUÉS de que la cuenta se cierre', async () => {
    /*
     * El fallo que esto fija, y que estuvo desplegado.
     *
     * El comensal declara su pago y la pantalla le promete «podrás pedir la
     * factura cuando el restaurante confirme tu pago». Confirmarlo **cierra la
     * cuenta**, y la ruta resolvía la cuenta con `openBillForGuest`, que exige
     * `status = 'OPEN'`. Así que la factura dejaba de poder pedirse justo en el
     * instante en que pasaba a poder pedirse: la promesa era incumplible.
     *
     * Una factura es de un pago, no de una cuenta abierta.
     */
    const { billId, paymentId } = await billWithPayment();
    const { session, token } = await scan();

    await db.query(`UPDATE bills SET status = 'CLOSED' WHERE id = $1`, [billId]);

    const res = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'ISSUED');
  });

  it('el comensal puede ver en qué quedó su pago, y si ya tiene factura', async () => {
    // Sin esta lectura el teléfono no tenía forma de enterarse de que se lo
    // confirmaron, y la promesa de arriba no tenía camino por el que cumplirse.
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();

    const antes = await request('GET', `/api/v1/guest/payments/${paymentId}`, { token, session });
    assert.equal(antes.status, 200, JSON.stringify(antes.body));
    assert.equal(antes.body.status, 'SUCCEEDED');
    assert.equal(antes.body.invoiced, false);

    await request('POST', '/api/v1/guest/bill/invoice', { body: { paymentId }, token, session });

    const luego = await request('GET', `/api/v1/guest/payments/${paymentId}`, { token, session });
    assert.equal(luego.body.invoiced, true, 'para no ofrecer dos veces lo mismo');
  });

  it('no se puede consultar ni facturar el pago de otra mesa', async () => {
    // El aislamiento no se relaja por resolver desde el pago: tiene que estar
    // en una cuenta de la mesa de esta sesión.
    const otherTable = await fixtures.createTable(restaurant.id, { name: `OT${++seq}` });
    const otherBill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: otherTable.id, totalDue: 0, totalDueVes: 0
    });
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, 5000, 'CASH', 'GUEST', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, otherBill.id]
    );
    const { session, token } = await scan();

    const read = await request('GET', `/api/v1/guest/payments/${rows[0].id}`, { token, session });
    assert.equal(read.status, 404, 'de otra mesa consta como inexistente');

    const invoice = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId: rows[0].id }, token, session
    });
    assert.equal(invoice.status, 404);
  });

  /* ------------------------------------------------------------- el panel */

  it('el personal lee las facturas, con sus líneas y su desglose', async () => {
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();
    const issued = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));

    const list = await request('GET', '/api/v1/fiscal/invoices', { token: staffToken });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.data.length >= 1);

    const one = await request('GET', `/api/v1/fiscal/invoices/${issued.body.invoice.id}`, { token: staffToken });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    assert.ok(one.body.lines.length >= 1, 'las líneas');
    assert.ok(one.body.taxes.length >= 1, 'y el desglose, que es lo que se declara');
    assert.equal(one.body.taxes[0].vatBps, 1600);
  });

  it('leer una factura emitida NO lo cierra el plan, ni bajando de escalón', async () => {
    /*
     * La regla dura de todo el módulo, comprobada donde importa.
     *
     * El deber legal de conservar una factura es del restaurante y sobrevive a
     * la suscripción. Una factura que dejara de poder leerse porque una factura
     * quedó sin pagar sería un problema creado por Splite.
     */
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();
    const issued = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });
    assert.equal(issued.status, 201);

    await db.query(`UPDATE restaurants SET plan_tier = 'TRIAL' WHERE id = $1`, [restaurant.id]);
    try {
      const list = await request('GET', '/api/v1/fiscal/invoices', { token: staffToken });
      assert.equal(list.status, 200, 'el listado sigue abierto');

      const one = await request('GET', `/api/v1/fiscal/invoices/${issued.body.invoice.id}`, { token: staffToken });
      assert.equal(one.status, 200, 'y el documento también');
      assert.equal(one.body.controlNumber, issued.body.invoice.controlNumber);

      const queue = await request('GET', '/api/v1/fiscal/requests?status=UNCERTAIN', { token: staffToken });
      assert.equal(queue.status, 200, 'y la cola, que también es una lectura');
    } finally {
      await db.query(`UPDATE restaurants SET plan_tier = 'ENTERPRISE' WHERE id = $1`, [restaurant.id]);
    }
  });

  it('la cola saca lo más viejo primero, al revés que las facturas', async () => {
    // Una duda de ayer es más urgente que una de hace un minuto.
    const queue = await request('GET', '/api/v1/fiscal/requests', { token: staffToken });
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    const dates = queue.body.data.map(r => new Date(r.createdAt).getTime());
    assert.deepEqual(dates, [...dates].sort((a, b) => a - b), 'ascendente por fecha');
  });

  it('resolver pregunta al proveedor, y no vuelve a pedir la emisión', async () => {
    const { paymentId } = await billWithPayment();
    const flaky = createMockProvider();
    providers.register('mock', {
      issue: async (d) => { await flaky.issue(d); throw Object.assign(new Error('t'), { status: 504 }); },
      lookup: async () => { throw Object.assign(new Error('t'), { status: 504 }); }
    });
    const { session, token } = await scan();
    const pending = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });
    assert.equal(pending.body.status, 'UNCERTAIN');

    // Ahora sí se puede preguntar.
    providers.register('mock', { issue: flaky.issue, lookup: k => flaky.lookup(k) });
    const resolved = await request('POST', `/api/v1/fiscal/requests/${pending.body.requestId}/resolve`,
      { token: staffToken });

    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.status, 'ISSUED');
    assert.equal(flaky.__issued.size, 1, 'el proveedor emitió una sola vez');
  });

  it('resolver algo que no estaba en duda no llama al proveedor', async () => {
    const { paymentId } = await billWithPayment();
    const { session, token } = await scan();
    const issued = await request('POST', '/api/v1/guest/bill/invoice', {
      body: { paymentId }, token, session
    });

    const { rows } = await db.query(
      'SELECT id FROM fiscal_invoice_requests WHERE id = (SELECT request_id FROM fiscal_invoices WHERE id = $1)',
      [issued.body.invoice.id]
    );
    const res = await request('POST', `/api/v1/fiscal/requests/${rows[0].id}/resolve`, { token: staffToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.unchanged, true, 'ya era un hecho: no hay nada que preguntar');
  });
});
