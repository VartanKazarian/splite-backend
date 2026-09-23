const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const app = require('../../src/app');
const billItems = require('../../src/services/billItems');
const invoicing = require('../../src/services/fiscalInvoicing');
const providers = require('../../src/fiscal/providers');
const { createMockProvider } = require('../../src/fiscal/providers/mock');

/**
 * Descargar una factura, y que lo que se descarga diga la verdad.
 *
 * Dos cosas:
 *
 *   - El PDF sale para el restaurante dueño de la factura y para nadie más: la
 *     carga reutiliza la del correo, que busca por id sin mirar de quién es.
 *   - En una carta en dólares, cada línea se declara con su cantidad real y su
 *     precio en bolívares. Las líneas llegaban en la moneda de la carta y la
 *     cantidad prorrateada salía multiplicada por la tasa: un tequeño se
 *     declaraba como 852,417 tequeños.
 */
describe('la factura en PDF, y sus líneas en bolívares', { skip }, () => {
  let server, base, restaurant, other, ownerToken, otherToken, seq = 0;

  const clearIpRateLimits = () => redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1');
  beforeEach(clearIpRateLimits);

  const mint = async (tenant, role) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3) RETURNING id`,
      [tenant.id, `${role.toLowerCase()}-${tenant.id}@example.com`, role]
    );
    return signAccessToken({ id: rows[0].id, restaurantId: tenant.id, role });
  };

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Pdf Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Pdf Tenant' });
    await db.query(
      `UPDATE restaurants SET plan_tier = 'ENTERPRISE', vat_bps = 1600, service_charge_bps = 0,
              rif = $2, menu_currency = 'USD' WHERE id = $1`,
      [restaurant.id, `J${String(Date.now()).slice(-9)}`]
    );
    ownerToken = await mint(restaurant, 'OWNER');
    otherToken = await mint(other, 'OWNER');
    providers.register('mock', createMockProvider());

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.purgeFiscal(restaurant?.id);
    for (const tenant of [restaurant, other]) {
      if (!tenant) continue;
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [tenant.id]);
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [tenant.id]);
      await fixtures.destroyRestaurant(tenant.id);
    }
    await db.close();
    await closeRedis();
  });

  /** Una cuenta en dólares, a 850,50 Bs por dólar, con un plato de $8 pagado entero. */
  async function paidUsdBill() {
    const table = await fixtures.createTable(restaurant.id, { name: `P${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0,
      currency: 'USD', fxRate: '850.50000000'
    });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1', [bill.id]);
    const { rows: [product] } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, 800, 'USD', true, 'TAXABLE') RETURNING id`,
      [restaurant.id, `Tequeños-${++seq}`]
    );
    const { bill: updated } = await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product.id, quantity: 1
    });
    const { rows: [payment] } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, bill.id, updated.total_due_ves]
    );
    const result = await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId: payment.id,
      provider: 'mock', customer: { name: null, taxId: null, email: 'ana@example.com' }
    });
    assert.equal(result.status, 'ISSUED');
    return result.invoice.id;
  }

  it('una línea en dólares se declara con su cantidad real y su precio en bolívares', async () => {
    const invoiceId = await paidUsdBill();
    const { rows: [line] } = await db.query(
      `SELECT quantity_milli, unit_price_minor, base_minor
         FROM fiscal_invoice_lines WHERE invoice_id = $1`, [invoiceId]
    );
    assert.equal(String(line.quantity_milli), '1000', 'un plato es un plato, no 850,5');
    // $8,00 a 850,50 = 6.804,00 Bs.
    assert.equal(String(line.unit_price_minor), '680400');
    assert.equal(String(line.base_minor), '680400');
  });

  it('el restaurante descarga su factura en PDF', async () => {
    const invoiceId = await paidUsdBill();
    const res = await fetch(`${base}/api/v1/fiscal/invoices/${invoiceId}/pdf`, {
      headers: { authorization: `Bearer ${ownerToken}` }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="factura-[A-Za-z0-9._-]+\.pdf"$/);
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 5).toString(), '%PDF-', 'es un PDF de verdad');
    assert.ok(body.length > 1000);
  });

  it('otro restaurante no puede descargarla, aunque conozca el id', async () => {
    const invoiceId = await paidUsdBill();
    const res = await fetch(`${base}/api/v1/fiscal/invoices/${invoiceId}/pdf`, {
      headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(res.status, 404);
  });

  it('sin sesión del personal no hay PDF', async () => {
    const invoiceId = await paidUsdBill();
    const res = await fetch(`${base}/api/v1/fiscal/invoices/${invoiceId}/pdf`);
    assert.equal(res.status, 401);
  });
});
