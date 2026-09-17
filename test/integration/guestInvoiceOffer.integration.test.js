const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const config = require('../../src/config');
const { signQrPayload } = require('../../src/utils/tokens');
const billItems = require('../../src/services/billItems');

/**
 * Lo que se le promete al comensal sobre su factura.
 *
 * La regla que esto sostiene es una sola: **`canRequestInvoice` y lo que el
 * servidor acepta no pueden discrepar.** Si la cuenta dice que sí y pedirla
 * devuelve 403, la app ha prometido algo que no puede cumplir -- que es
 * exactamente el fallo del que nace esta bandera, y el que volvería a aparecer
 * el día que alguien cambie una de las dos condiciones y no la otra.
 *
 * Por eso cada caso comprueba las dos cosas a la vez y no sólo la bandera: una
 * prueba que mirara únicamente el booleano seguiría pasando el día que el
 * servidor empezara a rechazar por otro motivo.
 */
describe('ofrecer factura al comensal', { skip }, () => {
  let server, base, restaurant, seq = 0;

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
    restaurant = await fixtures.createRestaurant({ name: 'Offer Tenant' });
    // Con RIF: es contenido obligatorio de la factura, así que sin él este
    // restaurante no podría emitir y toda la suite mediría otra cosa. El valor
    // es único por índice parcial, de ahí el sufijo del reloj.
    await db.query(
      `UPDATE restaurants
          SET vat_bps = 1600, service_charge_bps = 0, plan_tier = 'ENTERPRISE', rif = $2
        WHERE id = $1`,
      [restaurant.id, `J${String(Date.now()).slice(-9)}`]
    );
    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.purgeFiscal(restaurant?.id);
    if (restaurant) {
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  /** Una mesa con su cuenta, un plato pagado, y la sesión de quien lo pagó. */
  async function tableReadyToInvoice() {
    const created = await fixtures.createTable(restaurant.id, { name: `O${++seq}` });
    const { rows: [table] } = await db.query(
      'SELECT id, restaurant_id, qr_nonce FROM tables WHERE id = $1', [created.id]
    );

    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1', [bill.id]);
    const { rows: [product] } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, 10000, 'VES', true, 'TAXABLE') RETURNING id`,
      [restaurant.id, `Plato-${++seq}`]
    );
    const { bill: updated } = await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product.id, quantity: 1
    });
    const { rows: [payment] } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, bill.id, updated.total_due]
    );

    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: restaurant.id, nonce: table.qr_nonce,
      iat: now, ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const scan = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(scan.status, 201, JSON.stringify(scan.body));

    return { paymentId: payment.id, session: scan.body.sessionId, token: scan.body.guestToken };
  }

  /**
   * Lo que la cuenta promete y lo que pedirla contesta, en la misma llamada.
   *
   * Devolver los dos juntos es lo que hace que ninguna prueba de aquí pueda
   * comprobar sólo la mitad.
   */
  async function offerAndAttempt() {
    const { paymentId, session, token } = await tableReadyToInvoice();
    const status = await request('GET', `/api/v1/guest/payments/${paymentId}`, { session, token });
    assert.equal(status.status, 200, JSON.stringify(status.body));

    const attempt = await request('POST', '/api/v1/guest/bill/invoice', {
      session, token, body: { paymentId }
    });
    return { promised: status.body.canRequestInvoice, attempt };
  }

  const setPlan = (tier) =>
    db.query('UPDATE restaurants SET plan_tier = $2 WHERE id = $1', [restaurant.id, tier]);

  it('con todo en su sitio, lo promete y lo cumple', async () => {
    await setPlan('ENTERPRISE');
    const { promised, attempt } = await offerAndAttempt();

    assert.equal(promised, true);
    assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
    assert.equal(attempt.body.status, 'ISSUED');
  });

  it('sin el plan no lo promete, y tampoco lo acepta', async () => {
    /*
     * El caso que se veía en producción. Antes de la bandera, la cuenta no
     * decía nada y la pantalla previa prometía igual; el comensal se enteraba
     * al pulsar, con el cobro ya confirmado.
     */
    await setPlan('PRO');
    const { promised, attempt } = await offerAndAttempt();

    assert.equal(promised, false, 'la cuenta lo dice de antemano');
    assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
    assert.equal(attempt.body.error.code, 'PLAN_UPGRADE_REQUIRED',
      'y el servidor rechaza por el mismo motivo: las dos caras coinciden');
  });

  it('subir de plan cambia la promesa sin tocar nada más', async () => {
    // El remedio que tiene el restaurante, visto desde la cuenta del comensal.
    await setPlan('TRIAL');
    assert.equal((await offerAndAttempt()).promised, false);

    await setPlan('ENTERPRISE');
    const { promised, attempt } = await offerAndAttempt();
    assert.equal(promised, true);
    assert.equal(attempt.status, 201, JSON.stringify(attempt.body));
  });

  it('prometerlo no es garantizarlo: un cobro sin confirmar sigue sin facturarse', async () => {
    /*
     * `canRequestInvoice` responde «aquí se factura», no «esta factura va a
     * salir». Lo segundo depende del cobro, y decirlo mal en la otra dirección
     * -- ocultar la oferta porque un pago concreto aún no ha entrado -- sería
     * el mismo error con el signo cambiado.
     */
    await setPlan('ENTERPRISE');
    const { paymentId, session, token } = await tableReadyToInvoice();

    const status = await request('GET', `/api/v1/guest/payments/${paymentId}`, { session, token });
    assert.equal(status.body.canRequestInvoice, true);

    const bill = await request('GET', '/api/v1/guest/bill', { session, token });
    const { rows: [pending] } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, 1000, 'PAGO_MOVIL', 'GUEST', 'PENDING') RETURNING id`,
      [restaurant.id, bill.body.id]
    );
    const attempt = await request('POST', '/api/v1/guest/bill/invoice', {
      session, token, body: { paymentId: pending.id }
    });

    assert.equal(attempt.status, 409, JSON.stringify(attempt.body));
    assert.equal(attempt.body.error.code, 'PAYMENT_STATE_INVALID');
  });

  it('sobrevive al cierre de la cuenta, que es cuando hace falta', async () => {
    /*
     * La razón de que la bandera viaje con el pago y no con la cuenta.
     *
     * Confirmar el cobro es lo que cierra la mesa, así que el instante en que
     * la factura empieza a poder pedirse es exactamente el instante en que
     * `GET /guest/bill` deja de contestar. Una bandera que viviera allí
     * desaparecería justo cuando el comensal la necesita -- y ésa es la
     * pantalla en la que le decíamos «aquí no se piden las facturas».
     */
    await setPlan('ENTERPRISE');
    const { paymentId, session, token } = await tableReadyToInvoice();

    const bill = await request('GET', '/api/v1/guest/bill', { session, token });
    await db.query("UPDATE bills SET status = 'CLOSED' WHERE id = $1", [bill.body.id]);

    const closed = await request('GET', '/api/v1/guest/bill', { session, token });
    assert.notEqual(closed.status, 200, 'la cuenta ya no se puede leer');

    const status = await request('GET', `/api/v1/guest/payments/${paymentId}`, { session, token });
    assert.equal(status.status, 200);
    assert.equal(status.body.billClosed, true);
    assert.equal(status.body.canRequestInvoice, true, 'y aun así se sabe que aquí sí se factura');
  });
it('sin el RIF del emisor no lo promete, y tampoco lo acepta', async () => {
    /*
     * El RIF del contribuyente es contenido obligatorio de una factura fiscal.
     * Antes no lo comprobaba nadie: el correo lo imprimía con un
     * `if (restaurant.rif)` y el recibo lo pasaba como `?? null`, así que un
     * restaurante sin RIF emitía documentos incompletos **en silencio** -- la
     * peor forma de fallar aquí, porque el papel sale y parece una factura.
     */
    await setPlan('ENTERPRISE');
    const { rows: [saved] } = await db.query(
      'SELECT rif FROM restaurants WHERE id = $1', [restaurant.id]
    );
    await db.query('UPDATE restaurants SET rif = NULL WHERE id = $1', [restaurant.id]);

    try {
      const { promised, attempt } = await offerAndAttempt();
      assert.equal(promised, false, 'la cuenta lo dice de antemano');
      assert.equal(attempt.status, 409, JSON.stringify(attempt.body));
      assert.equal(attempt.body.error.code, 'FISCAL_RIF_MISSING',
        'y el servidor rechaza por el mismo motivo');
    } finally {
      await db.query('UPDATE restaurants SET rif = $2 WHERE id = $1', [restaurant.id, saved.rif]);
    }
  });

  it('un RIF en blanco cuenta como no tenerlo', async () => {
    // Una cadena vacía sale igual de blanca en el documento que un nulo, así
    // que tratarla como «sí tiene» sería dejar pasar exactamente lo mismo.
    await setPlan('ENTERPRISE');
    const { rows: [saved] } = await db.query(
      'SELECT rif FROM restaurants WHERE id = $1', [restaurant.id]
    );
    await db.query("UPDATE restaurants SET rif = '   ' WHERE id = $1", [restaurant.id]);

    try {
      const { promised, attempt } = await offerAndAttempt();
      assert.equal(promised, false);
      assert.equal(attempt.body.error.code, 'FISCAL_RIF_MISSING');
    } finally {
      await db.query('UPDATE restaurants SET rif = $2 WHERE id = $1', [restaurant.id, saved.rif]);
    }
  });
});
