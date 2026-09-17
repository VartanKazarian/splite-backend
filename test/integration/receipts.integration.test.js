const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const billItems = require('../../src/services/billItems');
const receipts = require('../../src/services/receipts');

/**
 * El recibo: la cuenta entera, y después lo que puso cada quien.
 *
 * La garantía que da sentido al formato es la primera, y es la única que no se
 * puede comprobar leyendo el código: **dos comensales de la misma mesa reciben
 * exactamente la misma cuenta.** Mismos productos, mismo subtotal, mismo IVA,
 * mismo total. Lo único que cambia entre sus dos recibos es el bloque del pago.
 *
 * Sin eso el documento no sirve para lo que existe: que cuatro personas puedan
 * poner sus cuatro recibos uno al lado del otro y comprobar que cuentan la
 * misma cena.
 *
 * Lo demás que se fija aquí es que el recibo **cuadre**: que las líneas sumen
 * el subtotal, que el IVA por alícuota sume el IVA, y que el total impreso sea
 * el que la cuenta tiene guardado. Un recibo que no cuadra con su propia cuenta
 * es peor que no dar recibo.
 */
describe('Recibos', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Receipt Tenant' });
    await db.query(
      `UPDATE restaurants SET rif = $2, fiscal_address = $3 WHERE id = $1`,
      [restaurant.id, `J${String(100000000 + (Date.now() % 89999999))}`, 'Av. Principal, Caracas']
    );
  });

  after(async () => {
    if (restaurant) await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const product = async (name, priceMinor, { taxCategory = 'TAXABLE', vatBps = null } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO menu_products
         (restaurant_id, name, price_minor_units, currency, active, tax_category, vat_bps)
       VALUES ($1, $2, $3, 'VES', true, $4, $5)
       RETURNING id`,
      [restaurant.id, `${name}-${++seq}`, priceMinor, taxCategory, vatBps]
    );
    return rows[0];
  };

  const billAt = async ({ vatBps = 1600, serviceBps = 1000 } = {}) => {
    const table = await fixtures.createTable(restaurant.id, { name: `R${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, currency: 'VES'
    });
    await db.query(
      'UPDATE bills SET vat_bps = $1, service_charge_bps = $2 WHERE id = $3',
      [vatBps, serviceBps, bill.id]
    );
    return { ...bill, table };
  };

  const pay = async (billId, amountVes, { tipVes = 0, method = 'PAGO_MOVIL', reference = null } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO payments
         (restaurant_id, bill_id, amount_ves, tip_ves, status, payment_method,
          payer_type, declared_reference)
       VALUES ($1, $2, $3, $4, 'SUCCEEDED', $5, 'GUEST', $6)
       RETURNING id`,
      [restaurant.id, billId, String(amountVes), String(tipVes), method, reference]
    );
    return rows[0].id;
  };

  /**
   * Una mesa con tres cosas y dos alícuotas: gravado al 16% y un exento.
   *
   *   Pabellón   2 x 18,90  =  37,80   gravado
   *   Agua       3 x  5,40  =  16,20   gravado
   *   Pan        1 x  5,00  =   5,00   exento
   *
   *   subtotal 59,00 · IVA 8,64 sobre base 54,00 · servicio 5,90 · total 73,54
   *
   * Las cifras van escritas a mano y no sacadas del motor: una regresión no
   * debe poder validarse a sí misma.
   */
  const dinner = async () => {
    const bill = await billAt();
    const pabellon = await product('Pabellon', 1890);
    const agua = await product('Agua', 540);
    const pan = await product('Pan', 500, { taxCategory: 'EXEMPT' });
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: pabellon.id, quantity: 2 });
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: agua.id, quantity: 3 });
    await billItems.addItem({ restaurantId: restaurant.id, billId: bill.id, productId: pan.id, quantity: 1 });
    return bill;
  };

  it('la cuenta del recibo es idéntica para dos comensales de la misma mesa', async () => {
    const bill = await dinner();
    const ana = await pay(bill.id, 4000, { tipVes: 300, reference: '2228699' });
    const luis = await pay(bill.id, 3354, { method: 'CASH' });

    const [one, two] = await Promise.all([
      receipts.forPayment({ restaurantId: restaurant.id, paymentId: ana }),
      receipts.forPayment({ restaurantId: restaurant.id, paymentId: luis })
    ]);

    // Lo que importa: todo menos el pago es el mismo documento.
    assert.deepEqual(one.bill, two.bill);
    assert.deepEqual(one.restaurant, two.restaurant);
    assert.deepEqual(one.table, two.table);

    // Y el pago es lo único que cambia.
    assert.notDeepEqual(one.payment, two.payment);
    assert.equal(one.payment.amountVes, '4000');
    assert.equal(two.payment.amountVes, '3354');
  });

  it('el recibo cuadra: líneas, alícuotas y total', async () => {
    const bill = await dinner();
    const receipt = await receipts.forPayment({
      restaurantId: restaurant.id, paymentId: await pay(bill.id, 1000)
    });

    const lines = receipt.bill.lines;
    assert.equal(lines.length, 3);
    assert.equal(
      lines.reduce((sum, line) => sum + BigInt(line.subtotalMinor), 0n).toString(),
      receipt.bill.subtotalMinor
    );

    // Las cifras escritas a mano.
    assert.equal(receipt.bill.subtotalMinor, '5900');
    assert.equal(receipt.bill.serviceChargeMinor, '590');
    assert.equal(receipt.bill.vatMinor, '864');
    assert.equal(receipt.bill.totalMinor, '7354');

    // Una fila por alícuota, y suman el IVA impreso.
    assert.deepEqual(receipt.bill.taxes, [
      { vatBps: 0, baseMinor: '500', vatMinor: '0' },
      { vatBps: 1600, baseMinor: '5400', vatMinor: '864' }
    ]);
    assert.equal(
      receipt.bill.taxes.reduce((sum, tax) => sum + BigInt(tax.vatMinor), 0n).toString(),
      receipt.bill.vatMinor
    );

    // Y el total impreso es el que la cuenta tiene guardado, no uno paralelo.
    const stored = await db.query('SELECT total_due, total_due_ves FROM bills WHERE id = $1', [bill.id]);
    assert.equal(receipt.bill.totalMinor, String(stored.rows[0].total_due));
    assert.equal(receipt.bill.totalVes, String(stored.rows[0].total_due_ves));
  });

  it('la propina va al lado del importe, nunca dentro', async () => {
    const bill = await dinner();
    const receipt = await receipts.forPayment({
      restaurantId: restaurant.id, paymentId: await pay(bill.id, 4000, { tipVes: 600 })
    });

    // `amount_ves` es lo que liquida de la cuenta; lo entregado es la suma.
    assert.equal(receipt.payment.amountVes, '4000');
    assert.equal(receipt.payment.tipVes, '600');
    assert.equal(receipt.payment.handedOverVes, '4600');
  });

  it('el encabezado lleva el local, y calla lo que no sabe', async () => {
    const bill = await dinner();
    const receipt = await receipts.forPayment({
      restaurantId: restaurant.id, paymentId: await pay(bill.id, 1000)
    });
    assert.equal(receipt.restaurant.name, 'Receipt Tenant');
    assert.equal(receipt.restaurant.address, 'Av. Principal, Caracas');
    assert.equal(receipt.table.name, bill.table.name);

    // Un restaurante sin dirección registrada no enseña un hueco: enseña null,
    // y la pantalla omite la línea. Inventarla sería peor.
    //
    // El RIF se vacía a mano: el fixture pone uno, porque sin él no se puede
    // emitir una factura fiscal y media suite fiscal estaría midiendo otra
    // cosa. Aquí hace falta el estado contrario, así que se provoca a la vista
    // en vez de heredarlo de un fixture incompleto.
    const other = await fixtures.createRestaurant({ name: 'Sin Datos' });
    await db.query('UPDATE restaurants SET rif = NULL WHERE id = $1', [other.id]);
    try {
      const table = await fixtures.createTable(other.id, { name: 'N1' });
      const plain = await fixtures.createBill({
        restaurantId: other.id, tableId: table.id, totalDue: 0, currency: 'VES'
      });
      const { rows } = await db.query(
        `INSERT INTO payments (restaurant_id, bill_id, amount_ves, status, payment_method, payer_type)
         VALUES ($1, $2, '1', 'SUCCEEDED', 'CASH', 'GUEST') RETURNING id`,
        [other.id, plain.id]
      );
      const bare = await receipts.forPayment({ restaurantId: other.id, paymentId: rows[0].id });
      assert.equal(bare.restaurant.rif, null);
      assert.equal(bare.restaurant.address, null);
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('un pago de otro restaurante no existe', async () => {
    const bill = await dinner();
    const paymentId = await pay(bill.id, 1000);
    const other = await fixtures.createRestaurant({ name: 'Vecino' });
    try {
      await assert.rejects(
        receipts.forPayment({ restaurantId: other.id, paymentId }),
        err => err.code === 'PAYMENT_NOT_FOUND'
      );
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });
});
