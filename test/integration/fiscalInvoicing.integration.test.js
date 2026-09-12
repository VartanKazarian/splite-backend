const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const providers = require('../../src/fiscal/providers');
const { createMockProvider } = require('../../src/fiscal/providers/mock');
const invoicing = require('../../src/services/fiscalInvoicing');
const billItems = require('../../src/services/billItems');

/**
 * El recorrido entero: de un cobro a un documento, contra base de datos real.
 *
 * Lo que estas pruebas persiguen no es el camino bueno -- ése se prueba solo --
 * sino los dos que cuestan dinero: que una respuesta ambigua no acabe en una
 * factura duplicada, y que lo que se registra cuando por fin se aclara sea el
 * documento que el proveedor emitió y no uno reconstruido después.
 */
describe('emisión de facturas', { skip }, () => {
  let restaurant, mock;
  let seq = 0;
  const PROVIDER = 'mock-it';

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Invoicing Tenant' });
    await db.query(
      'UPDATE restaurants SET vat_bps = 1600, service_charge_bps = 1000 WHERE id = $1',
      [restaurant.id]
    );
  });

  beforeEach(() => {
    mock = createMockProvider();
    providers.register(PROVIDER, mock);
  });

  after(async () => {
    if (restaurant) {
      await db.query('ALTER TABLE fiscal_invoices DISABLE TRIGGER fiscal_invoices_immutable');
      await db.query('ALTER TABLE fiscal_invoice_lines DISABLE TRIGGER fiscal_invoice_lines_immutable');
      await db.query('ALTER TABLE fiscal_invoice_taxes DISABLE TRIGGER fiscal_invoice_taxes_immutable');
      await db.query('DELETE FROM fiscal_invoice_lines WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM fiscal_invoice_taxes WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM fiscal_invoices WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('ALTER TABLE fiscal_invoices ENABLE TRIGGER fiscal_invoices_immutable');
      await db.query('ALTER TABLE fiscal_invoice_lines ENABLE TRIGGER fiscal_invoice_lines_immutable');
      await db.query('ALTER TABLE fiscal_invoice_taxes ENABLE TRIGGER fiscal_invoice_taxes_immutable');
      await db.query('DELETE FROM fiscal_invoice_requests WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  /** Una cuenta con una hamburguesa gravada y una harina exenta. */
  async function openBill() {
    const table = await fixtures.createTable(restaurant.id, { name: `I${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    await db.query(
      'UPDATE bills SET vat_bps = 1600, service_charge_bps = 1000 WHERE id = $1', [bill.id]
    );

    const product = async (name, price, taxCategory) => {
      const { rows } = await db.query(
        `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
         VALUES ($1, $2, $3, 'VES', true, $4) RETURNING id`,
        [restaurant.id, `${name}-${++seq}`, price, taxCategory]
      );
      return rows[0].id;
    };

    const gravado = await product('Hamburguesa', 50000, 'TAXABLE');
    const exento = await product('Harina', 20000, 'EXEMPT');
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: gravado, quantity: 1 });
    const { bill: updated } = await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: exento, quantity: 1
    });
    return updated;
  }

  const pay = async (billId, amount) => {
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, billId, amount]
    );
    return rows[0].id;
  };

  it('emite, y lo declarado es lo que se cobró', async () => {
    const bill = await openBill();
    // 700 de subtotal, 80 de IVA (sólo sobre los 500), 70 de servicio = 850.
    assert.equal(bill.total_due, '85000');

    const paymentId = await pay(bill.id, 85000);
    const out = await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId, provider: PROVIDER
    });

    assert.equal(out.status, 'ISSUED', JSON.stringify(out));
    assert.equal(out.invoice.total_minor, '85000');
    assert.equal(out.invoice.vat_minor, '8000', 'el exento no arrastra IVA');
    assert.equal(out.invoice.service_minor, '7000');

    const taxes = await db.query(
      'SELECT vat_bps, base_minor, vat_minor FROM fiscal_invoice_taxes WHERE invoice_id = $1 ORDER BY vat_bps',
      [out.invoice.id]
    );
    assert.equal(taxes.rows.length, 2, 'una fila por alícuota: es lo que se declara');
    assert.equal(taxes.rows[0].vat_bps, 0);
    assert.equal(taxes.rows[0].vat_minor, '0');
    assert.equal(taxes.rows[1].vat_bps, 1600);
    assert.equal(taxes.rows[1].vat_minor, '8000');
  });

  it('varias facturas sobre una mesa suman la cuenta, y no más', async () => {
    const bill = await openBill();
    const total = 85000n;

    let declared = 0n;
    for (const amount of [30000, 25000, 30000]) {
      const paymentId = await pay(bill.id, amount);
      const out = await invoicing.issueForPayment({
        restaurantId: restaurant.id, billId: bill.id, paymentId, provider: PROVIDER
      });
      assert.equal(out.status, 'ISSUED', JSON.stringify(out));
      declared += BigInt(out.invoice.total_minor);
    }
    assert.equal(declared, total, 'tres facturas que suman la cuenta exacta');

    const sums = await db.query(
      `SELECT COALESCE(SUM(t.base_minor),0)::TEXT AS base, COALESCE(SUM(t.vat_minor),0)::TEXT AS vat
         FROM fiscal_invoice_taxes t JOIN fiscal_invoices i ON i.id = t.invoice_id
        WHERE i.bill_id = $1`, [bill.id]
    );
    assert.equal(sums.rows[0].base, '70000', 'la base declarada es la de la cuenta');
    assert.equal(sums.rows[0].vat, '8000', 'y el IVA, ni un céntimo de más');
  });

  it('no deja declarar más de lo que la cuenta tiene', async () => {
    const bill = await openBill();
    const first = await pay(bill.id, 85000);
    await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId: first, provider: PROVIDER
    });

    const extra = await pay(bill.id, 1000);
    await assert.rejects(
      () => invoicing.issueForPayment({
        restaurantId: restaurant.id, billId: bill.id, paymentId: extra, provider: PROVIDER
      }),
      err => {
        assert.equal(err.code, 'FISCAL_NOTHING_TO_DECLARE');
        return true;
      }
    );
  });

  it('una respuesta ambigua se consulta, y si emitió se registra sin duplicar', async () => {
    /*
     * El caso entero, que es la razón de todo este diseño.
     *
     * El proveedor emite y la respuesta se pierde. Si esto se leyera como fallo
     * y se reintentara, la mesa acabaría con dos documentos por el mismo cobro
     * -- y no se pueden borrar.
     */
    const bill = await openBill();
    const paymentId = await pay(bill.id, 85000);
    mock.__setBehaviour('SILENT_SUCCESS');

    const out = await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId, provider: PROVIDER
    });

    assert.equal(out.status, 'ISSUED', 'preguntar lo resolvió sin emitir de nuevo');

    const count = await db.query(
      'SELECT count(*)::INT AS n FROM fiscal_invoices WHERE bill_id = $1', [bill.id]
    );
    assert.equal(count.rows[0].n, 1, 'un solo documento, no dos');
    assert.equal(mock.__issued.size, 1, 'y el proveedor sólo emitió una vez');
  });

  it('lo que no se puede aclarar queda en duda, esperando a una persona', async () => {
    // Inventar un desenlace para no dejar nada pendiente es lo único que no se
    // puede hacer aquí. Quedarse en la cola es el final correcto.
    const bill = await openBill();
    const paymentId = await pay(bill.id, 85000);
    providers.register(PROVIDER, {
      issue: async () => { throw Object.assign(new Error('timeout'), { status: 504 }); },
      lookup: async () => { throw Object.assign(new Error('timeout'), { status: 504 }); }
    });

    const out = await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId, provider: PROVIDER
    });

    assert.equal(out.status, 'UNCERTAIN');
    const rows = await db.query(
      'SELECT status FROM fiscal_invoice_requests WHERE id = $1', [out.requestId]
    );
    assert.equal(rows.rows[0].status, 'UNCERTAIN', 'y queda marcado para mirarlo');

    const none = await db.query(
      'SELECT count(*)::INT AS n FROM fiscal_invoices WHERE bill_id = $1', [bill.id]
    );
    assert.equal(none.rows[0].n, 0, 'sin documento inventado');
  });

  it('resolver una duda registra el borrador que se mandó, no uno nuevo', async () => {
    /*
     * La razón de guardar el borrador.
     *
     * Entre la duda y la aclaración la cuenta sigue viva: pagan otros y se
     * emiten otras facturas. Reconstruir el borrador entonces daría otro
     * documento -- pero el que existe ahí fuera es el primero.
     */
    const bill = await openBill();
    const paymentId = await pay(bill.id, 30000);

    // Se pierde la respuesta y no se puede preguntar: queda en duda.
    const flaky = createMockProvider();
    providers.register(PROVIDER, {
      issue: async (d) => { await flaky.issue(d); throw Object.assign(new Error('t'), { status: 504 }); },
      lookup: async () => { throw Object.assign(new Error('t'), { status: 504 }); }
    });
    const first = await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId, provider: PROVIDER
    });
    assert.equal(first.status, 'UNCERTAIN');

    // Mientras tanto, otro comensal paga y factura.
    providers.register(PROVIDER, createMockProvider());
    const second = await pay(bill.id, 25000);
    await invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId: second, provider: PROVIDER
    });

    // Ahora sí se puede preguntar, y resulta que la primera sí se emitió.
    providers.register(PROVIDER, {
      issue: flaky.issue,
      lookup: async (key) => flaky.lookup(key)
    });
    const resolved = await invoicing.resolveUncertain({
      restaurantId: restaurant.id, requestId: first.requestId
    });

    assert.equal(resolved.status, 'ISSUED', JSON.stringify(resolved));
    assert.equal(resolved.invoice.total_minor, '30000',
      'se registró por los 300 que se pagaron, no por lo que hoy quedaría');
  });

  it('un cobro que aún no ha entrado no se factura', async () => {
    // Facturar algo que quizá no cuaje produciría un documento que habría que
    // compensar mañana. Se espera.
    const bill = await openBill();
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, 10000, 'PAGO_MOVIL', 'GUEST', 'PENDING') RETURNING id`,
      [restaurant.id, bill.id]
    );
    await assert.rejects(
      () => invoicing.issueForPayment({
        restaurantId: restaurant.id, billId: bill.id, paymentId: rows[0].id, provider: PROVIDER
      }),
      err => {
        assert.equal(err.code, 'PAYMENT_STATE_INVALID');
        return true;
      }
    );
  });
});
