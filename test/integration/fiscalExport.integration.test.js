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
 * Las facturas de un mes, para el contador, sobre HTTP.
 *
 * Lo que sólo se puede comprobar con base de datos: que el mes sea el de
 * Caracas y no el de UTC, que no salga nada de otro restaurante y que la lista
 * entera de clientes no la pueda sacar cualquiera del personal.
 */
describe('exportación mensual de facturas', { skip }, () => {
  let server, base, restaurant, other, ownerToken, waiterToken, otherToken, seq = 0;

  const clearIpRateLimits = () => redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1');
  beforeEach(clearIpRateLimits);

  const mint = async (tenant, role) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3) RETURNING id`,
      [tenant.id, `${role.toLowerCase()}-${++seq}-${tenant.id}@example.com`, role]
    );
    return signAccessToken({ id: rows[0].id, restaurantId: tenant.id, role });
  };

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Export Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Export Tenant' });
    for (const tenant of [restaurant, other]) {
      await db.query(
        `UPDATE restaurants SET plan_tier = 'ENTERPRISE', vat_bps = 1600, service_charge_bps = 0
          WHERE id = $1`,
        [tenant.id]
      );
    }
    ownerToken = await mint(restaurant, 'OWNER');
    waiterToken = await mint(restaurant, 'WAITER');
    otherToken = await mint(other, 'OWNER');
    providers.register('mock', createMockProvider());

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const tenant of [restaurant, other]) {
      if (!tenant) continue;
      await fixtures.purgeFiscal(tenant.id);
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [tenant.id]);
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [tenant.id]);
      await fixtures.destroyRestaurant(tenant.id);
    }
    await db.close();
    await closeRedis();
  });

  /** Una factura emitida, y luego movida a la fecha que la prueba necesita. */
  async function invoiceAt(tenant, issuedAtIso, customer = {}) {
    const table = await fixtures.createTable(tenant.id, { name: `X${++seq}` });
    const bill = await fixtures.createBill({ restaurantId: tenant.id, tableId: table.id, totalDue: 0, totalDueVes: 0 });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1', [bill.id]);
    const { rows: [product] } = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, 10000, 'VES', true, 'TAXABLE') RETURNING id`,
      [tenant.id, `Plato-${++seq}`]
    );
    const { bill: updated } = await billItems.addItem({
      restaurantId: tenant.id, billId: bill.id, productId: product.id, quantity: 1
    });
    const { rows: [payment] } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [tenant.id, bill.id, updated.total_due_ves]
    );
    const result = await invoicing.issueForPayment({
      restaurantId: tenant.id, billId: bill.id, paymentId: payment.id,
      provider: 'mock', customer: { name: null, taxId: null, email: null, ...customer }
    });
    assert.equal(result.status, 'ISSUED');
    // Los documentos son inmutables por trigger; la prueba mueve la fecha en
    // una transacción propia sin disparar triggers, sólo en esta sesión.
    await db.withTransaction(async client => {
      await client.query("SET LOCAL session_replication_role = 'replica'");
      await client.query('UPDATE fiscal_invoices SET issued_at = $2 WHERE id = $1', [result.invoice.id, issuedAtIso]);
    });
    return { documentNumber: result.invoice.document_number, tableName: table.name };
  }

  const exportFor = (month, token = ownerToken) => fetch(
    `${base}/api/v1/fiscal/invoices/export?month=${month}`,
    { headers: token ? { authorization: `Bearer ${token}` } : {} }
  );

  it('el mes es el de Caracas: el 31 a las 23:30 es del mes que acaba', async () => {
    // 2026-08-31 23:30 en Caracas (UTC-4) son las 03:30 del 1 de septiembre en UTC.
    const lateAugust = await invoiceAt(restaurant, '2026-09-01T03:30:00Z', { name: 'Ana Pérez', taxId: 'V12345678' });
    // Y el 1 de septiembre a las 00:30 de Caracas es septiembre.
    const earlySeptember = await invoiceAt(restaurant, '2026-09-01T04:30:00Z');

    const august = await (await exportFor('2026-08')).text();
    const september = await (await exportFor('2026-09')).text();

    assert.ok(august.includes(lateAugust.documentNumber), 'la cena del 31 por la noche es de agosto');
    assert.ok(!august.includes(earlySeptember.documentNumber));
    assert.ok(september.includes(earlySeptember.documentNumber));
    assert.ok(!september.includes(lateAugust.documentNumber), 'y no se cuela en septiembre por la hora UTC');

    const row = august.split('\r\n').find(l => l.includes(lateAugust.documentNumber)).split(';');
    assert.equal(row[0], '31/08/2026');
    assert.ok(row.includes('Ana Pérez'));
    assert.ok(row.includes('V12345678'));
    assert.ok(row.includes(lateAugust.tableName), 'con la mesa');
    assert.ok(row.includes('100,00'), 'la base del 16 %');
    assert.ok(row.includes('16,00'), 'y su IVA');
    assert.equal(row.at(-1), 'Sí', 'el proveedor simulado se marca como documento de prueba');
  });

  it('se descarga como fichero, sin caché', async () => {
    const res = await exportFor('2026-07');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="facturas-2026-07.csv"');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...body.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'con BOM, para que Excel lea UTF-8');
  });

  it('no trae facturas de otro restaurante', async () => {
    const theirs = await invoiceAt(other, '2026-06-15T15:00:00Z');
    const mine = await (await exportFor('2026-06')).text();
    assert.ok(!mine.includes(theirs.documentNumber));
    const theirExport = await (await exportFor('2026-06', otherToken)).text();
    assert.ok(theirExport.includes(theirs.documentNumber), 'y a su dueño sí');
  });

  it('un mesero no puede sacar la lista de clientes', async () => {
    const res = await exportFor('2026-08', waiterToken);
    assert.equal(res.status, 403);
  });

  it('sin sesión no hay fichero, y un mes mal escrito es un 400', async () => {
    assert.equal((await exportFor('2026-08', null)).status, 401);
    assert.equal((await exportFor('2026-8')).status, 400);
    assert.equal((await exportFor('agosto')).status, 400);
  });
});
