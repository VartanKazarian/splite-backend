const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const billItems = require('../../src/services/billItems');
const providers = require('../../src/fiscal/providers');
const { createMockProvider } = require('../../src/fiscal/providers/mock');
const mailer = require('../../src/services/mailer');
const fiscalMail = require('../../src/services/fiscalMail');
const invoicing = require('../../src/services/fiscalInvoicing');

/**
 * La factura, en el correo de quien la pidió.
 *
 * La afirmación que gobierna el archivo entero es la primera, y es sobre lo que
 * **no** puede pasar: **un fallo de correo no puede impedir emitir**. El
 * documento está declarado ante el SENIAT en cuanto la imprenta lo devuelve;
 * que el proveedor de correo esté caído no puede deshacer eso ni convertirlo en
 * un error delante del comensal. Lo que falta entonces es una entrega, no una
 * factura.
 *
 * Lo demás se sigue de ahí: la entrega se anota aunque no salga, se puede
 * reintentar después, y no se manda dos veces.
 */
describe('entrega de la factura por correo', { skip }, () => {
  let restaurant, table, seq = 0;
  let sent;          // los mensajes que el transporte vio
  let failWith;      // cuando se quiere un proveedor de correo caído

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Mail Tenant' });
    await db.query(
      `UPDATE restaurants SET plan_tier = 'ENTERPRISE', vat_bps = 1600,
              service_charge_bps = 1000, rif = $2, fiscal_address = $3 WHERE id = $1`,
      [restaurant.id, `J${String(Date.now()).slice(-9)}`, 'Av. Principal, Caracas']
    );
    table = await fixtures.createTable(restaurant.id, { name: 'M1' });
    providers.register('mock', createMockProvider());
  });

  /*
   * Se sustituye el transporte y no `mailer.send`: `send` es el que decide no
   * lanzar nunca y traducir el fallo a `{ sent: false }`, que es justo la parte
   * de la que depende todo esto. Anularlo probaría un mailer que no existe.
   */
  const realLog = mailer.TRANSPORTS.log;
  beforeEach(() => {
    sent = [];
    failWith = null;
    mailer.TRANSPORTS.log = async (message) => {
      if (failWith) throw new Error(failWith);
      sent.push(message);
      return { id: `msg-${sent.length}`, transport: 'log' };
    };
  });

  after(async () => {
    mailer.TRANSPORTS.log = realLog;
    await db.query(
      `DELETE FROM fiscal_invoice_deliveries WHERE restaurant_id = $1`, [restaurant.id]
    );
    await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    await db.close();
  });

  /** Una cuenta itemizada con un cobro liquidado encima. */
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

  const issue = (ids, customer) => invoicing.issueForPayment({
    restaurantId: restaurant.id, billId: ids.billId, paymentId: ids.paymentId,
    provider: 'mock', customer: { name: null, taxId: null, email: null, ...customer }
  });

  const deliveryFor = async (invoiceId) => (await db.query(
    `SELECT email, status, attempts, last_error, sent_at
       FROM fiscal_invoice_deliveries WHERE invoice_id = $1`, [invoiceId]
  )).rows;

  /** El envío del camino caliente no se espera, así que se le da un respiro. */
  const settle = () => new Promise(resolve => setTimeout(resolve, 300));

  it('un proveedor de correo caído NO impide emitir la factura', async () => {
    /*
     * La prueba que justifica el diseño entero.
     *
     * Si esto fallara, una caída de Resend convertiría cada petición de factura
     * en un error delante de un comensal cuyo pago ya está cobrado -- y, peor,
     * podría dejar sin emitir un documento que el restaurante tiene que
     * declarar igual.
     */
    failWith = 'smtp is down';
    const result = await issue(await billWithPayment(), { email: 'ana@example.com' });
    await settle();

    assert.equal(result.status, 'ISSUED', 'la factura se emite pase lo que pase con el correo');
    assert.ok(result.invoice.control_number, 'y con su número de control');

    const [delivery] = await deliveryFor(result.invoice.id);
    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.attempts, 1);
    assert.match(delivery.last_error, /smtp is down/);
    assert.equal(delivery.sent_at, null);
  });

  it('con correo, la factura sale y la entrega queda registrada', async () => {
    const result = await issue(await billWithPayment(), { email: 'luis@example.com' });
    await settle();

    const [delivery] = await deliveryFor(result.invoice.id);
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.email, 'luis@example.com');
    assert.ok(delivery.sent_at, 'una entrega enviada lleva fecha; la base lo exige');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'luis@example.com');
    assert.match(sent[0].text, /TOTAL/);
    // El importe del documento, en el cuerpo. Es lo que se mira al abrirlo.
    assert.match(sent[0].text, /126,00 Bs/);
  });

  it('consumidor final no genera ninguna entrega, ni correo', async () => {
    // El caso mayoritario. Sin dirección no hay nada que mandar, y una fila de
    // entrega vacía convertiría lo normal en algo pendiente para siempre.
    const result = await issue(await billWithPayment());
    await settle();

    assert.deepEqual(await deliveryFor(result.invoice.id), []);
    assert.equal(sent.length, 0);
  });

  it('el barrido recoge lo que quedó sin salir', async () => {
    /*
     * El precio de no esperar el envío en el camino caliente: un proceso que se
     * reinicia deja la entrega en PENDING. Sin barrido esa factura no se
     * mandaría nunca, que es peor que la latencia que se ahorró.
     */
    failWith = 'provider timeout';
    const result = await issue(await billWithPayment(), { email: 'cae@example.com' });
    await settle();
    assert.equal((await deliveryFor(result.invoice.id))[0].status, 'FAILED');

    failWith = null;
    const counts = await fiscalMail.sweepPending({ limit: 50 });
    assert.ok(counts.sent >= 1, JSON.stringify(counts));

    const [delivery] = await deliveryFor(result.invoice.id);
    assert.equal(delivery.status, 'SENT');
    assert.equal(delivery.attempts, 2, 'el reintento cuenta como intento');
    assert.equal(delivery.last_error, null, 'y limpia el error del anterior');
  });

  it('una factura no se manda dos veces a la misma dirección', async () => {
    const result = await issue(await billWithPayment(), { email: 'dos@example.com' });
    await settle();

    // Un barrido que se cruce con el envío original no puede producir un
    // segundo correo: la entrega ya está en SENT y el índice único impide
    // siquiera una segunda fila.
    await fiscalMail.sweepPending({ limit: 50 });
    await assert.rejects(
      db.query(
        `INSERT INTO fiscal_invoice_deliveries (restaurant_id, invoice_id, email)
         VALUES ($1, $2, 'DOS@example.com')`,
        [restaurant.id, result.invoice.id]
      ),
      err => err.code === '23505'
    );

    assert.equal((await deliveryFor(result.invoice.id)).length, 1);
    assert.equal(sent.filter(m => m.to === 'dos@example.com').length, 1);
  });

  it('un documento del proveedor simulado dice que no es una factura fiscal', async () => {
    // La segunda valla, después del guardarraíl de arranque. Entregar un
    // documento con números inventados como si fuera bueno es un problema
    // tributario con sanción.
    await issue(await billWithPayment(), { email: 'prueba@example.com' });
    await settle();

    const [message] = sent;
    assert.match(message.text, /NO ES UNA FACTURA FISCAL/);
    assert.match(message.subject, /^\[PRUEBA\]/);
  });

  it('sale con el nombre del restaurante, y sin correo de contacto dice a quién pedir la corrección', async () => {
    await db.query('UPDATE restaurants SET contact_email = NULL WHERE id = $1', [restaurant.id]);
    await issue(await billWithPayment(), { email: 'ana@example.com' });
    await settle();

    const [message] = sent;
    assert.equal(message.fromName, 'Mail Tenant vía Splite');
    assert.equal(message.replyTo, undefined, 'sin correo de contacto no hay a quién responder');
    assert.match(message.text, /no recibe respuestas/);
    assert.match(message.text, /pídele la corrección a Mail Tenant/);
  });

  it('con correo de contacto, las respuestas le llegan al restaurante', async () => {
    await db.query(
      "UPDATE restaurants SET contact_email = 'facturas@mailtenant.example' WHERE id = $1",
      [restaurant.id]
    );
    try {
      await issue(await billWithPayment(), { email: 'ana@example.com' });
      await settle();

      const [message] = sent;
      assert.equal(message.replyTo, 'facturas@mailtenant.example');
      assert.match(message.text, /responde a este correo/);
      assert.match(message.text, /facturas@mailtenant\.example/);
      assert.doesNotMatch(message.text, /no recibe respuestas/,
        'con Reply-To sí se puede responder: decir lo contrario sería falso');
    } finally {
      await db.query('UPDATE restaurants SET contact_email = NULL WHERE id = $1', [restaurant.id]);
    }
  });
});
