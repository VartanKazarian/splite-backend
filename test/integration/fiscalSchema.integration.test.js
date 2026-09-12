const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');

/**
 * Las garantías del esquema fiscal, contra una base de datos de verdad.
 *
 * Todo lo que se afirma aquí vive en la base y no en la aplicación, que es el
 * punto: una regla que sólo cumple la capa de servicio la incumple la consola
 * que alguien abre a las once de la noche con buena intención. Estas pruebas
 * escriben SQL directo a propósito -- si pasaran por el servicio no estarían
 * comprobando la base, estarían comprobando el servicio.
 */
describe('esquema fiscal', { skip }, () => {
  let restaurant, table, bill;
  let seq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Fiscal Schema Tenant' });
    table = await fixtures.createTable(restaurant.id, { name: 'F1' });
    bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
  });

  after(async () => {
    if (restaurant) {
      // El disparador de inmutabilidad also bloquea el borrado, así que para
      // limpiar hay que desactivarlo. Que haga falta esto en una prueba es la
      // demostración más directa de que está puesto.
      await db.query('ALTER TABLE fiscal_invoices DISABLE TRIGGER fiscal_invoices_immutable');
      await db.query('ALTER TABLE fiscal_invoice_taxes DISABLE TRIGGER fiscal_invoice_taxes_immutable');
      await db.query('DELETE FROM fiscal_invoice_taxes WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('DELETE FROM fiscal_invoices WHERE restaurant_id = $1', [restaurant.id]);
      await db.query('ALTER TABLE fiscal_invoices ENABLE TRIGGER fiscal_invoices_immutable');
      await db.query('ALTER TABLE fiscal_invoice_taxes ENABLE TRIGGER fiscal_invoice_taxes_immutable');
      await db.query('DELETE FROM fiscal_invoice_requests WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  /**
   * Una cuenta nueva por petición, salvo que se diga otra cosa.
   *
   * No es cosmético: desde la migración 040 una cuenta admite **una sola**
   * petición a nivel de cuenta -- las que van sin pago, que son las de factura
   * única de mesa. Compartir la cuenta entre peticiones haría que estas pruebas
   * chocaran con esa regla en vez de con la que cada una quiere comprobar.
   */
  const newRequest = async (overrides = {}) => {
    let billId = overrides.billId;
    if (!billId) {
      if (overrides.paymentId) {
        billId = bill.id;
      } else {
        const t = await fixtures.createTable(restaurant.id, { name: `R${++seq}` });
        const b = await fixtures.createBill({
          restaurantId: restaurant.id, tableId: t.id, totalDue: 0, totalDueVes: 0
        });
        billId = b.id;
      }
    }
    const { rows } = await db.query(
      `INSERT INTO fiscal_invoice_requests (restaurant_id, bill_id, idempotency_key, status, payment_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [restaurant.id, billId, overrides.key ?? `k-${++seq}`,
        overrides.status ?? 'ISSUED', overrides.paymentId ?? null]
    );
    return rows[0];
  };

  const newInvoice = async (overrides = {}) => {
    const request = overrides.request ?? await newRequest();
    const { rows } = await db.query(
      `INSERT INTO fiscal_invoices
         (restaurant_id, request_id, bill_id, document_number, control_number, provider,
          line_basis, subtotal_minor, vat_minor, service_minor, total_minor, issued_at,
          document_type, compensates_id)
       VALUES ($1, $2, $3, $4, $5, 'mock', $6, $7, $8, $9, $10, now(), $11, $12)
       RETURNING *`,
      [restaurant.id, request.id, request.bill_id,
        overrides.number ?? `F-${seq}`, overrides.control ?? `CTRL-${seq}`,
        overrides.basis ?? 'AGGREGATE',
        overrides.subtotal ?? 1000, overrides.vat ?? 160, overrides.service ?? 0,
        overrides.total ?? 1160,
        overrides.type ?? 'INVOICE', overrides.compensates ?? null]
    );
    return rows[0];
  };

  it('una factura emitida no se puede modificar ni borrar', async () => {
    const invoice = await newInvoice();

    await assert.rejects(
      () => db.query('UPDATE fiscal_invoices SET total_minor = 9999 WHERE id = $1', [invoice.id]),
      err => {
        assert.match(err.message, /inmutables/);
        return true;
      },
      'un UPDATE sobre un registro legal tiene que rebotar en la base'
    );

    await assert.rejects(
      () => db.query('DELETE FROM fiscal_invoices WHERE id = $1', [invoice.id]),
      /inmutables/
    );

    const { rows } = await db.query('SELECT total_minor FROM fiscal_invoices WHERE id = $1', [invoice.id]);
    assert.equal(rows[0].total_minor, '1160', 'y la fila sigue exactamente como se emitió');
  });

  it('la petición sí cambia de estado: es lo que no es un registro legal', async () => {
    const request = await newRequest({ status: 'PENDING' });
    await db.query('UPDATE fiscal_invoice_requests SET status = $1 WHERE id = $2', ['UNCERTAIN', request.id]);

    const { rows } = await db.query('SELECT status FROM fiscal_invoice_requests WHERE id = $1', [request.id]);
    assert.equal(rows[0].status, 'UNCERTAIN');
  });

  it('un total que no cuadra con sus partes no se puede guardar', async () => {
    // La misma garantía que ya tiene `bills`, por la misma razón: un documento
    // que se contradice a sí mismo no debe existir ni un instante.
    await assert.rejects(
      () => newInvoice({ subtotal: 1000, vat: 160, service: 0, total: 9999 }),
      err => {
        assert.equal(err.code, '23514');
        assert.equal(err.constraint, 'fiscal_invoices_total_check');
        return true;
      }
    );
  });

  it('una nota de crédito tiene que decir qué compensa, y una factura no', async () => {
    // Una factura emitida no se corrige: se compensa. Un documento que dice ser
    // nota de crédito sin nombrar a quién compensa no compensa nada.
    await assert.rejects(
      () => newInvoice({ type: 'CREDIT_NOTE', compensates: null }),
      err => {
        assert.equal(err.constraint, 'fiscal_invoices_compensates_check');
        return true;
      }
    );

    const original = await newInvoice();
    await assert.rejects(
      () => newInvoice({ type: 'INVOICE', compensates: original.id }),
      err => {
        assert.equal(err.constraint, 'fiscal_invoices_compensates_check');
        return true;
      },
      'una factura normal no compensa a nadie'
    );

    // Y la nota bien formada sí entra.
    const note = await newInvoice({ type: 'CREDIT_NOTE', compensates: original.id });
    assert.equal(note.compensates_id, original.id);
  });

  it('dos facturas no pueden compartir número de control del mismo proveedor', async () => {
    // El número de control lo pone la imprenta autorizada y es su serie.
    // Repetirlo sería declarar dos veces bajo el mismo folio.
    await newInvoice({ control: 'CTRL-DUP' });
    await assert.rejects(
      () => newInvoice({ control: 'CTRL-DUP' }),
      err => {
        assert.equal(err.code, '23505');
        return true;
      }
    );
  });

  it('un pago se factura una sola vez, aunque el comensal pulse dos veces', async () => {
    /*
     * La barrera estructural contra el duplicado.
     *
     * Una factura duplicada no es un error de aplicación que se arregla
     * borrando una fila -- no se puede borrar, y además ya se declaró. Así que
     * la imposibilidad tiene que estar en la base y no en un `if`.
     */
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, 1160, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, bill.id]
    );
    const paymentId = rows[0].id;

    await newRequest({ paymentId, status: 'PENDING' });
    await assert.rejects(
      () => newRequest({ paymentId, status: 'PENDING' }),
      err => {
        assert.equal(err.code, '23505');
        return true;
      }
    );
  });

  it('un intento fallido no bloquea volver a intentarlo', async () => {
    // El índice único deja fuera los FAILED a propósito: si un intento se cayó
    // sin emitir nada, el comensal tiene que poder pedir su factura otra vez.
    const { rows } = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, 500, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, bill.id]
    );
    const paymentId = rows[0].id;

    await newRequest({ paymentId, status: 'FAILED' });
    const retry = await newRequest({ paymentId, status: 'PENDING' });
    assert.equal(retry.payment_id, paymentId, 'se puede reintentar tras un fallo limpio');
  });

  it('el desglose no admite dos filas de la misma alícuota en un documento', async () => {
    const invoice = await newInvoice();
    const addTax = (bps, base, vat) => db.query(
      `INSERT INTO fiscal_invoice_taxes (invoice_id, restaurant_id, tax_category, vat_bps, base_minor, vat_minor)
       VALUES ($1, $2, 'TAXABLE', $3, $4, $5)`,
      [invoice.id, restaurant.id, bps, base, vat]
    );

    await addTax(1600, 1000, 160);
    await assert.rejects(() => addTax(1600, 500, 80), err => {
      assert.equal(err.code, '23505');
      return true;
    }, 'dos filas al 16% no son un desglose, son un error de construcción');

    // Otra alícuota sí, que es justo para lo que existe la tabla.
    await addTax(0, 200, 0);
  });

  it('en factura única de mesa, la cuenta no puede tener dos', async () => {
    /*
     * SINGLE_BILL emite una factura por la cuenta y no por un cobro, así que va
     * sin `payment_id`. Eso deja sin efecto al índice por pago -- todos serían
     * NULL -- y sin uno propio una mesa podría acabar con dos facturas por el
     * total, que es declarar la misma venta dos veces.
     */
    const otherTable = await fixtures.createTable(restaurant.id, { name: `S${++seq}` });
    const otherBill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: otherTable.id, totalDue: 0, totalDueVes: 0
    });

    const billLevel = (type = 'INVOICE') => db.query(
      `INSERT INTO fiscal_invoice_requests (restaurant_id, bill_id, idempotency_key, status, document_type)
       VALUES ($1, $2, $3, 'ISSUED', $4) RETURNING id`,
      [restaurant.id, otherBill.id, `bill-${++seq}`, type]
    );

    await billLevel();
    await assert.rejects(() => billLevel(), err => {
      assert.equal(err.code, '23505');
      return true;
    }, 'una segunda factura por la misma cuenta declararía la venta dos veces');

    // Una nota de crédito sobre esa misma cuenta sí tiene que caber: es
    // justamente lo que hace falta después para corregirla.
    const note = await billLevel('CREDIT_NOTE');
    assert.ok(note.rows[0].id);
  });

  it('no admite un estado ni un tipo de documento inventados', async () => {
    await assert.rejects(() => newRequest({ status: 'CASI' }), err => {
      assert.equal(err.code, '23514');
      return true;
    });
    await assert.rejects(() => newInvoice({ basis: 'A_OJO' }), err => {
      assert.equal(err.constraint, 'fiscal_invoices_basis_check');
      return true;
    });
  });
});
