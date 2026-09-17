const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const numbering = require('../../src/services/fiscalNumbering');
const invoicing = require('../../src/services/fiscalInvoicing');
const billItems = require('../../src/services/billItems');

/**
 * El correlativo, cuando el que lo pone somos nosotros.
 *
 * Emitiendo por medios propios hay dos promesas que sostener, y sólo una de
 * ellas la sostiene la base de datos sola. Que no se repita lo garantizan dos
 * índices únicos, y eso está probado en el momento en que existen. Que **no
 * falte ninguno** no lo garantiza nada de fuera: depende de esta implementación
 * y es lo que se prueba aquí.
 *
 * Por eso estas pruebas van contra Postgres de verdad y no contra un doble. Lo
 * que hay que demostrar -- que dos transacciones simultáneas se serializan, y
 * que una que no confirma no se lleva el número -- no es observable donde la
 * transacción está fingida: es exactamente el comportamiento que el doble
 * borra.
 */
describe('numeración fiscal propia', { skip }, () => {
  let restaurant;
  let seq = 0;

  const FIRST = 1000n;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Numbering Tenant' });
    await db.query(
      'UPDATE restaurants SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1',
      [restaurant.id]
    );
    await setSeries(restaurant.id, { controlFirst: FIRST });
  });

  after(async () => {
    await purgeFiscal(restaurant?.id);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  /** Lo del helper compartido, más lo que sólo este fichero crea. */
  async function purgeFiscal(restaurantId) {
    if (!restaurantId) return;
    await fixtures.purgeFiscal(restaurantId);
    await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurantId]);
  }

  /** La serie autorizada, tal y como la escribiría el dueño en ajustes. */
  async function setSeries(restaurantId, { controlFirst = 1n, controlLast = null } = {}) {
    await db.query(
      `INSERT INTO fiscal_series
         (restaurant_id, control_prefix, document_prefix, pad_to, control_first, control_last)
       VALUES ($1, '00-', 'F-', 8, $2, $3)
       ON CONFLICT (restaurant_id) DO UPDATE
         SET control_first = EXCLUDED.control_first, control_last = EXCLUDED.control_last`,
      [restaurantId, String(controlFirst), controlLast === null ? null : String(controlLast)]
    );
  }

  /** Una cuenta con un plato gravado, pagada de una vez. */
  async function billReadyToInvoice(restaurantId, priceMinor) {
    const table = await fixtures.createTable(restaurantId, { name: `N${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1', [bill.id]);

    const product = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, $3, 'VES', true, 'TAXABLE') RETURNING id`,
      [restaurantId, `Plato-${++seq}`, String(priceMinor)]
    );
    const { bill: updated } = await billItems.addItem({
      restaurantId, billId: bill.id, productId: product.rows[0].id, quantity: 1
    });

    const payment = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurantId, bill.id, updated.total_due]
    );
    return { billId: bill.id, paymentId: payment.rows[0].id };
  }

  const issue = (restaurantId, { billId, paymentId }) =>
    invoicing.issueForPayment({ restaurantId, billId, paymentId, provider: 'own' });

  const counterOf = async (restaurantId, scope) => {
    const { rows } = await db.query(
      'SELECT next_value FROM fiscal_counters WHERE restaurant_id = $1 AND scope = $2',
      [restaurantId, scope]
    );
    return rows.length ? BigInt(rows[0].next_value) : null;
  };

  it('ocho mesas pagando a la vez dan ocho números seguidos', async () => {
    /*
     * La prueba que justifica el diseño entero.
     *
     * Ocho cuentas distintas del mismo restaurante, facturadas a la vez. No se
     * estorban por la cuenta -- cada una es la suya --, así que lo único que
     * las ordena es el contador. Si el reparto no se serializara, aquí
     * saldrían números repetidos; y la comprobación de que no hay huecos es la
     * que un contador no transaccional no pasaría.
     */
    const N = 8;
    const bills = [];
    for (let i = 0; i < N; i += 1) bills.push(await billReadyToInvoice(restaurant.id, 10000 + i * 100));

    const issued = await Promise.all(bills.map(bill => issue(restaurant.id, bill)));

    for (const out of issued) {
      assert.equal(out.status, 'ISSUED', JSON.stringify(out));
    }

    const controls = issued.map(o => o.invoice.control_number).sort();
    const expected = Array.from({ length: N }, (_, i) =>
      `00-${(FIRST + BigInt(i)).toString().padStart(8, '0')}`);

    assert.equal(new Set(controls).size, N, 'ningún número de control repetido');
    assert.deepEqual(controls, expected, 'seguidos y sin huecos, desde el primero autorizado');

    // Y el par no se cruza: quien se llevó el control k se llevó el documento k.
    // Los dos contadores se reparten bajo el mismo bloqueo, así que el orden de
    // uno tiene que ser el orden del otro.
    const byControl = [...issued].sort(
      (a, b) => a.invoice.control_number.localeCompare(b.invoice.control_number)
    );
    assert.deepEqual(
      byControl.map(o => o.invoice.document_number),
      Array.from({ length: N }, (_, i) => `F-${String(i + 1).padStart(8, '0')}`),
      'el correlativo de documento va emparejado con el de control'
    );

    assert.equal(await counterOf(restaurant.id, 'CONTROL'), FIRST + BigInt(N));
    assert.equal(await counterOf(restaurant.id, 'INVOICE'), BigInt(N + 1));
  });

  it('una factura que no llega a guardarse no se lleva el número', async () => {
    /*
     * Lo que descarta una SEQUENCE.
     *
     * `nextval` fuera de la transacción habría dejado ese número consumido para
     * siempre, y el libro de ventas con un hueco que en una fiscalización hay
     * que explicar. Repartiendo con la fila bloqueada, el ROLLBACK devuelve el
     * contador a donde estaba y el siguiente documento se lleva ese número.
     */
    const startedAt = await counterOf(restaurant.id, 'CONTROL');
    let abandoned;

    await assert.rejects(
      db.withTransaction(async (client) => {
        abandoned = await numbering.allocate(client, { restaurantId: restaurant.id });
        throw new Error('la factura no se pudo escribir');
      }),
      /no se pudo escribir/
    );

    assert.equal(await counterOf(restaurant.id, 'CONTROL'), startedAt,
      'el contador volvió solo a donde estaba');

    const next = await db.withTransaction(client =>
      numbering.allocate(client, { restaurantId: restaurant.id })
    );
    assert.equal(next.controlNumber, abandoned.controlNumber,
      'el número abandonado se reparte otra vez, no se salta');
  });

  it('pasado el rango autorizado se rechaza en vez de seguir contando', async () => {
    // Un número fuera del rango no es una errata: es un documento que no está
    // amparado por ninguna autorización. Hay que ir a pedir un rango nuevo, y
    // para eso esto tiene que notarse.
    const other = await fixtures.createRestaurant({ name: 'Numbering Range' });
    try {
      await setSeries(other.id, { controlFirst: 1n, controlLast: 2n });

      const take = () => db.withTransaction(client =>
        numbering.allocate(client, { restaurantId: other.id }));

      assert.equal((await take()).controlNumber, '00-00000001');
      assert.equal((await take()).controlNumber, '00-00000002');

      await assert.rejects(take(), err => {
        assert.equal(err.code, 'FISCAL_RANGE_EXHAUSTED');
        assert.equal(err.details.lastAuthorised, '2');
        return true;
      });

      assert.equal(await counterOf(other.id, 'CONTROL'), 3n,
        'el rechazo tampoco mueve el contador');
    } finally {
      await purgeFiscal(other.id);
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('sin serie configurada no se inventa una', async () => {
    // El rango lo autoriza el SENIAT. Empezar por el 1 «mientras tanto» sería
    // emitir números que no le corresponden a nadie.
    const other = await fixtures.createRestaurant({ name: 'Numbering Unset' });
    try {
      await assert.rejects(
        db.withTransaction(client => numbering.allocate(client, { restaurantId: other.id })),
        err => {
          assert.equal(err.code, 'FISCAL_SERIES_MISSING');
          return true;
        }
      );
      assert.equal(await counterOf(other.id, 'CONTROL'), null, 'ni contador se creó');
    } finally {
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('cada restaurante cuenta por su cuenta', async () => {
    // El correlativo es del contribuyente, no del sistema. Dos locales que
    // facturan a la vez no pueden compartir serie ni estorbarse.
    const other = await fixtures.createRestaurant({ name: 'Numbering Neighbour' });
    try {
      await setSeries(other.id, { controlFirst: 500n });
      const mine = await counterOf(restaurant.id, 'CONTROL');

      const theirs = await db.withTransaction(client =>
        numbering.allocate(client, { restaurantId: other.id }));

      assert.equal(theirs.controlNumber, '00-00000500', 'arranca en su propio rango');
      assert.equal(await counterOf(restaurant.id, 'CONTROL'), mine,
        'y no toca el contador del vecino');
    } finally {
      await purgeFiscal(other.id);
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('dos restaurantes pueden llevar el mismo número', async () => {
    /*
     * El correlativo es **del contribuyente**, no del sistema.
     *
     * Dos restaurantes con autorizaciones distintas pueden tener perfectamente
     * el mismo número de control: cada uno lo lleva en su propio libro. Si la
     * unicidad se guardara a lo ancho de toda la plataforma, el segundo local
     * que estrenara Splite chocaría contra las facturas del primero y no podría
     * emitir -- y no habría nada que arreglar en su autorización, porque es
     * correcta.
     */
    // Los dos son nuevos y arrancan en el 1, que es el choque exacto.
    const twins = [];
    try {
      for (const name of ['Numbering Twin A', 'Numbering Twin B']) {
        const twin = await fixtures.createRestaurant({ name });
        await db.query('UPDATE restaurants SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1',
          [twin.id]);
        await setSeries(twin.id, { controlFirst: 1n });
        twins.push(twin);
      }

      for (const twin of twins) {
        const out = await issue(twin.id, await billReadyToInvoice(twin.id, 10000));
        assert.equal(out.invoice.control_number, '00-00000001',
          'el mismo número en dos libros distintos, que es lo correcto');
      }
    } finally {
      for (const twin of twins) {
        await purgeFiscal(twin.id);
        await fixtures.destroyRestaurant(twin.id);
      }
    }
  });
});
