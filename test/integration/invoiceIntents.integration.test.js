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
const claims = require('../../src/services/paymentClaims');
const invoiceIntents = require('../../src/services/invoiceIntents');

/**
 * «Envíame la factura», pedido al avisar del pago.
 *
 * Lo que estas pruebas sostienen son dos promesas que tiran en direcciones
 * opuestas:
 *
 *   - **La factura sale sola** cuando el personal confirma el cobro, al correo
 *     que se dio al avisar, sin que el comensal tenga que estar mirando.
 *   - **Nada de eso puede tumbar la confirmación.** Un cobro verificado se
 *     confirma aunque la factura no pueda salir, y el motivo queda anotado.
 */
describe('factura pedida con el aviso de pago', { skip }, () => {
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
    'guest:::ffff:127.0.0.1', 'guest:127.0.0.1'
  );
  beforeEach(clearIpRateLimits);

  const setPlan = tier =>
    db.query('UPDATE restaurants SET plan_tier = $2 WHERE id = $1', [restaurant.id, tier]);

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Intent Tenant' });
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

  /** Una mesa con un plato en la cuenta y la sesión de quien la escaneó. */
  async function seatedGuest() {
    const created = await fixtures.createTable(restaurant.id, { name: `I${++seq}` });
    const { rows: [table] } = await db.query(
      'SELECT id, qr_nonce FROM tables WHERE id = $1', [created.id]
    );
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1', [bill.id]);
    const { rows: [product] } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, 10000, 'VES', true, 'TAXABLE') RETURNING id`,
      [restaurant.id, `Plato-I-${++seq}`]
    );
    const { bill: updated } = await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product.id, quantity: 1
    });

    const now = Math.floor(Date.now() / 1000);
    const ttl = config.qrTtlSeconds;
    const qrToken = signQrPayload({
      v: 1, tableId: table.id, restaurantId: restaurant.id, nonce: table.qr_nonce,
      iat: now, ...(ttl > 0 ? { exp: now + ttl } : {})
    });
    const scan = await request('POST', '/api/v1/guest/sessions', { body: { qrToken } });
    assert.equal(scan.status, 201, JSON.stringify(scan.body));
    return {
      billId: bill.id,
      totalVes: String(updated.total_due),
      session: scan.body.sessionId,
      token: scan.body.guestToken
    };
  }

  const reference = () => String(Date.now()).slice(-8) + String(++seq).padStart(4, '0');

  async function declare(guest, invoice) {
    const res = await request('POST', '/api/v1/guest/bill/payment-claims', {
      session: guest.session, token: guest.token,
      body: { amountVes: guest.totalVes, reference: reference(), ...(invoice ? { invoice } : {}) }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id;
  }

  const status = (guest, paymentId) =>
    request('GET', `/api/v1/guest/payments/${paymentId}`, { session: guest.session, token: guest.token });

  it('la cuenta dice de antemano si se puede pedir, con el mismo cálculo que el pago', async () => {
    await setPlan('ENTERPRISE');
    const guest = await seatedGuest();
    const offered = await request('GET', '/api/v1/guest/bill', { session: guest.session, token: guest.token });
    assert.equal(offered.status, 200);
    assert.equal(offered.body.canRequestInvoice, true);

    await setPlan('PRO');
    const refused = await request('GET', '/api/v1/guest/bill', { session: guest.session, token: guest.token });
    assert.equal(refused.body.canRequestInvoice, false);
    await setPlan('ENTERPRISE');
  });

  it('se emite sola al confirmar el cobro, al correo que se dio al avisar', async () => {
    await setPlan('ENTERPRISE');
    const guest = await seatedGuest();
    const paymentId = await declare(guest, { email: 'ana@example.com' });

    // Mientras el cobro está por verificar, no hay factura: se espera.
    const waiting = await status(guest, paymentId);
    assert.equal(waiting.status, 200);
    assert.deepEqual(waiting.body.invoiceRequest, { email: 'ana@example.com', status: 'WAITING' });
    assert.equal(waiting.body.invoiced, false);
    assert.equal(waiting.body.invoice, null);
    const { rows: none } = await db.query(
      'SELECT 1 FROM fiscal_invoices WHERE payment_id = $1', [paymentId]
    );
    assert.equal(none.length, 0, 'pedirla no emite nada todavía');

    await claims.confirmClaim({ restaurantId: restaurant.id, claimId: paymentId, actor: { id: null } });

    const done = await status(guest, paymentId);
    assert.equal(done.body.status, 'SUCCEEDED');
    assert.equal(done.body.invoiced, true);
    assert.equal(done.body.invoiceRequest.status, 'ISSUED');
    assert.equal(done.body.invoice.email, 'ana@example.com');
    assert.ok(done.body.invoice.controlNumber, 'con su número de control, para enseñarlo');

    // Y la entrega quedó programada a esa dirección: sin esto la factura
    // existiría y no le llegaría a nadie.
    const { rows: deliveries } = await db.query(
      `SELECT d.email FROM fiscal_invoice_deliveries d
         JOIN fiscal_invoices i ON i.id = d.invoice_id
        WHERE i.payment_id = $1`, [paymentId]
    );
    assert.deepEqual(deliveries.map(d => d.email), ['ana@example.com']);
  });

  it('a nombre de quien lo pide, si da nombre y documento', async () => {
    await setPlan('ENTERPRISE');
    const guest = await seatedGuest();
    const paymentId = await declare(guest, {
      email: 'empresa@example.com', name: 'Empresa Tal', taxId: 'j123456789'
    });
    await claims.confirmClaim({ restaurantId: restaurant.id, claimId: paymentId, actor: { id: null } });

    const { rows: [invoice] } = await db.query(
      `SELECT customer_name, customer_tax_id, customer_email
         FROM fiscal_invoices WHERE payment_id = $1`, [paymentId]
    );
    assert.equal(invoice.customer_name, 'Empresa Tal');
    assert.equal(invoice.customer_tax_id, 'J123456789', 'normalizado como al pedirla a mano');
    assert.equal(invoice.customer_email, 'empresa@example.com');
  });

  it('si aquí no se factura, el cobro se confirma igual y el motivo queda anotado', async () => {
    /*
     * La regla que manda: un pago verificado no se queda sin confirmar porque
     * la factura no pueda salir. Y el aviso se acepta aunque lleve la petición,
     * porque rechazarlo impediría avisar de un pago ya enviado.
     */
    await setPlan('PRO');
    const guest = await seatedGuest();
    const paymentId = await declare(guest, { email: 'ana@example.com' });

    const confirmed = await claims.confirmClaim({
      restaurantId: restaurant.id, claimId: paymentId, actor: { id: null }
    });
    assert.equal(confirmed.status, 'CLOSED', 'la cuenta quedó saldada');

    const later = await status(guest, paymentId);
    assert.equal(later.body.status, 'SUCCEEDED');
    assert.equal(later.body.invoiced, false);
    assert.equal(later.body.invoiceRequest.status, 'FAILED');
    const { rows: [intent] } = await db.query(
      'SELECT last_error_code FROM fiscal_invoice_intents WHERE payment_id = $1', [paymentId]
    );
    assert.equal(intent.last_error_code, 'PLAN_UPGRADE_REQUIRED');
    await setPlan('ENTERPRISE');
  });

  it('un cobro rechazado no factura nada', async () => {
    await setPlan('ENTERPRISE');
    const guest = await seatedGuest();
    const paymentId = await declare(guest, { email: 'ana@example.com' });
    await claims.rejectClaim({ restaurantId: restaurant.id, claimId: paymentId, actor: { id: null } });

    const later = await status(guest, paymentId);
    assert.equal(later.body.invoiced, false);
    assert.equal(later.body.invoiceRequest.status, 'WAITING');
  });

  it('si la factura ya existía, no se hace otra', async () => {
    await setPlan('ENTERPRISE');
    const guest = await seatedGuest();
    const paymentId = await declare(guest, { email: 'ana@example.com' });
    await claims.confirmClaim({ restaurantId: restaurant.id, claimId: paymentId, actor: { id: null } });

    // Como si la petición no se hubiera cumplido todavía y la factura se
    // hubiera pedido a mano mientras tanto.
    await db.query(
      `UPDATE fiscal_invoice_intents SET status = 'WAITING', resolved_at = NULL, last_error_code = NULL
        WHERE payment_id = $1`, [paymentId]
    );
    const outcome = await invoiceIntents.fulfil({ restaurantId: restaurant.id, paymentId });
    assert.equal(outcome, 'SKIPPED');
    const { rows } = await db.query('SELECT 1 FROM fiscal_invoices WHERE payment_id = $1', [paymentId]);
    assert.equal(rows.length, 1, 'una sola factura por cobro');
  });

  it('sin correo no hay petición: el aviso lo rechaza por ese campo', async () => {
    const guest = await seatedGuest();
    const res = await request('POST', '/api/v1/guest/bill/payment-claims', {
      session: guest.session, token: guest.token,
      body: { amountVes: guest.totalVes, reference: reference(), invoice: { name: 'Ana' } }
    });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });
});
