const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const billItems = require('../../src/services/billItems');

/**
 * El IVA, calculado por alícuota.
 *
 * Hasta aquí una cuenta tenía una sola: `bills.vat_bps`, aplicada de una vez
 * sobre el subtotal entero. Da el número correcto mientras todo vaya gravado
 * igual, y no sirve para facturar, porque un documento fiscal declara base e
 * IVA por cada alícuota y hay productos que no llevan.
 *
 * Lo que estas pruebas fijan es lo que puede salir caro:
 *
 *   1. que el cambio **no mueva un céntimo** de lo que ya se calculaba;
 *   2. que un exento de verdad no pague IVA, y el gravado de al lado sí;
 *   3. que la categoría y la alícuota se congelen en la línea, como el precio;
 *   4. que la base de datos no admita un exento con alícuota propia.
 */
describe('IVA por alícuota', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Tax Tenant' });
  });

  after(async () => {
    if (restaurant) await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  /** Un producto de la carta, con su trato fiscal si se le da uno. */
  const product = async (name, priceMinor, { taxCategory = 'TAXABLE', vatBps = null } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO menu_products
         (restaurant_id, name, price_minor_units, currency, active, tax_category, vat_bps)
       VALUES ($1, $2, $3, 'VES', true, $4, $5)
       RETURNING id, name, tax_category, vat_bps`,
      [restaurant.id, `${name}-${++seq}`, priceMinor, taxCategory, vatBps]
    );
    return rows[0];
  };

  /**
   * Una cuenta en bolívares lista para itemizar, con las tasas del restaurante
   * copiadas encima.
   *
   * El fixture inserta directo, así que el snapshot se pone a mano: es lo que
   * hace la ruta al abrir una cuenta, y sin él `recalculateTotals` no tendría
   * de dónde sacar la alícuota general.
   */
  const billAt = async ({ vatBps = 1600, serviceBps = 0 } = {}) => {
    const table = await fixtures.createTable(restaurant.id, { name: `X${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, currency: 'VES'
    });
    await db.query(
      'UPDATE bills SET vat_bps = $1, service_charge_bps = $2 WHERE id = $3',
      [vatBps, serviceBps, bill.id]
    );
    return { ...bill, vat_bps: vatBps, service_charge_bps: serviceBps };
  };

  const add = (billId, productId, quantity = 1) =>
    billItems.addItem({ restaurantId: restaurant.id, billId, productId, quantity });

  it('todo gravado a la misma tasa da exactamente el total de siempre', async () => {
    /*
     * La prueba que protege lo que ya está cobrando.
     *
     * Con un solo grupo el subtotal del grupo es el subtotal de la cuenta, y la
     * operación es la de antes: un `applyBps` sobre el total. Se comprueba
     * contra aritmética escrita a mano y no contra lo que devuelva el motor,
     * para que una regresión no se valide a sí misma.
     *
     * Los precios están elegidos para que haya que redondear: 3 x 333 + 2 x 777
     * = 2553, cuyo 16% es 408,48.
     */
    const bill = await billAt({ vatBps: 1600, serviceBps: 1000 });
    const a = await product('Tequeños', 333);
    const b = await product('Malta', 777);

    await add(bill.id, a.id, 3);
    const { bill: updated } = await add(bill.id, b.id, 2);

    const subtotal = 333n * 3n + 777n * 2n;          // 2553
    assert.equal(subtotal, 2553n, 'la aritmética de la prueba, por si acaso');

    // 408,48 -> 408 y 255,3 -> 255, ambos a la mitad hacia arriba.
    assert.equal(updated.subtotal_minor, '2553');
    assert.equal(updated.vat_minor, '408');
    assert.equal(updated.service_charge_minor, '255');
    assert.equal(updated.total_due, '3216');

    const parts = BigInt(updated.subtotal_minor) + BigInt(updated.vat_minor) +
      BigInt(updated.service_charge_minor);
    assert.equal(parts.toString(), updated.total_due, 'el total es exactamente sus partes');
  });

  it('un exento no paga IVA, y el gravado de la misma cuenta sí', async () => {
    const bill = await billAt({ vatBps: 1600, serviceBps: 1000 });
    const gravado = await product('Hamburguesa', 500);
    const exento = await product('Harina de maíz', 200, { taxCategory: 'EXEMPT' });

    await add(bill.id, gravado.id, 1);
    const { bill: updated } = await add(bill.id, exento.id, 1);

    // El IVA sale sólo de los 500. Si el cálculo siguiera siendo de cuenta
    // entera saldrían 112 sobre 700 en vez de 80.
    assert.equal(updated.subtotal_minor, '700');
    assert.equal(updated.vat_minor, '80', '16% de 500, no de 700');
    assert.notEqual(updated.vat_minor, '112', 'el exento no puede arrastrar IVA');

    // El servicio sí se toma sobre el subtotal entero: no es un impuesto, y
    // que un plato esté exento de IVA no lo exime del servicio.
    assert.equal(updated.service_charge_minor, '70');
    assert.equal(updated.total_due, '850');
  });

  it('una alícuota propia manda sobre la general del restaurante', async () => {
    const bill = await billAt({ vatBps: 1600 });
    const reducido = await product('Libro', 1000, { vatBps: 800 });

    const { item, bill: updated } = await add(bill.id, reducido.id, 1);
    assert.equal(item.vat_bps, 800, 'la línea se queda con la del producto');
    assert.equal(updated.vat_minor, '80', '8% y no el 16% del local');
  });

  it('congela categoría y alícuota en la línea, como el precio', async () => {
    const bill = await billAt({ vatBps: 1600 });
    const cafe = await product('Café', 1000);

    const { item, bill: antes } = await add(bill.id, cafe.id, 1);
    assert.equal(item.tax_category, 'TAXABLE');
    assert.equal(item.vat_bps, 1600, 'resuelta al añadir, no un NULL que se relea');
    assert.equal(antes.vat_minor, '160');

    // El restaurante declara el producto exento **después** de servirlo.
    await db.query(
      'UPDATE menu_products SET tax_category = $1, vat_bps = NULL WHERE id = $2',
      ['EXEMPT', cafe.id]
    );

    // Se añade una segunda unidad, que fuerza a recalcular la cuenta entera.
    //
    // La línea vieja no se mueve: sigue pagando sus 160. La nueva es una venta
    // de ahora y va exenta. Por eso el IVA de la cuenta queda en 160 sobre un
    // subtotal de 2000 -- **no** en 320, que sería no haber cambiado nada, ni
    // en 0, que sería recalcular hacia atrás y cambiarle el impuesto a algo ya
    // servido. El congelado es por línea, y esto es lo que significa.
    const { bill: luego } = await add(bill.id, cafe.id, 1);
    assert.equal(luego.subtotal_minor, '2000');
    assert.equal(luego.vat_minor, '160', 'la línea vieja conserva su 16%, la nueva no paga');
    assert.notEqual(luego.vat_minor, '320', 'la línea nueva no puede seguir gravada');
    assert.notEqual(luego.vat_minor, '0', 'la línea vieja no puede desgravarse hacia atrás');

    // Y se comprueba en las líneas, que es donde vive el dato.
    const lineas = await billItems.listForBill({ restaurantId: restaurant.id, billId: bill.id });
    assert.deepEqual(
      lineas.map(l => [l.tax_category, l.vat_bps]).sort(),
      [['EXEMPT', 0], ['TAXABLE', 1600]],
      'dos ventas del mismo plato, cada una con el impuesto que le tocaba'
    );

    // Y una cuenta nueva sí recoge el cambio.
    const fresh = await billAt({ vatBps: 1600 });
    const { bill: hoy } = await add(fresh.id, cafe.id, 1);
    assert.equal(hoy.vat_minor, '0', 'el exento, a partir de ahora, no paga');
  });

  it('no admite un producto no gravado con alícuota propia', async () => {
    // La contradicción se rechaza también en el esquema de la ruta, con un
    // mensaje que dice cuál de los dos campos sobra. Esto fija el suelo: aunque
    // alguien escriba directo contra la tabla, no entra.
    await assert.rejects(
      () => product('Imposible', 1000, { taxCategory: 'EXEMPT', vatBps: 1600 }),
      err => {
        assert.equal(err.code, '23514', 'check_violation');
        assert.equal(err.constraint, 'menu_products_vat_only_when_taxable');
        return true;
      }
    );
  });

  it('no admite una categoría fiscal inventada', async () => {
    await assert.rejects(
      () => product('Rara', 1000, { taxCategory: 'SIN_IVA' }),
      err => {
        assert.equal(err.code, '23514');
        return true;
      }
    );
  });
});
