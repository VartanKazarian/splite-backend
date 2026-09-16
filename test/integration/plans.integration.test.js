const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const plans = require('../../src/services/plans');
const billItems = require('../../src/services/billItems');
const invoicing = require('../../src/services/fiscalInvoicing');

/**
 * Cambiar de plan a un restaurante que ya existe.
 *
 * Lo que se prueba aquí no es que el UPDATE escriba -- eso es lo fácil -- sino
 * las tres cosas que lo separan del UPDATE a mano que sustituye: que quede
 * rastro **siempre**, que salir de la prueba borre su fecha, y que bajar de
 * plan avise cuando le va a quitar al restaurante algo que ya viene usando.
 */
describe('planes', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Plan Tenant' });
    await db.query(
      'UPDATE restaurants SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1',
      [restaurant.id]
    );
    await db.query(
      `INSERT INTO fiscal_series (restaurant_id, control_prefix, document_prefix, pad_to, control_first)
       VALUES ($1, '00-', 'F-', 8, 1)`,
      [restaurant.id]
    );
  });

  beforeEach(async () => {
    await db.query(
      "UPDATE restaurants SET plan_tier = 'TRIAL', trial_ends_at = NOW() + INTERVAL '30 days' WHERE id = $1",
      [restaurant.id]
    );
    await db.query(
      "DELETE FROM audit_logs WHERE restaurant_id = $1 AND action = 'PLAN_CHANGED'",
      [restaurant.id]
    );
  });

  after(async () => {
    await fixtures.purgeFiscal(restaurant?.id);
    if (restaurant) {
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant.id]);
    }
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const tierOf = async () => {
    const { rows } = await db.query(
      'SELECT plan_tier, trial_ends_at FROM restaurants WHERE id = $1', [restaurant.id]
    );
    return rows[0];
  };

  const auditRows = async () => {
    const { rows } = await db.query(
      `SELECT details FROM audit_logs
        WHERE restaurant_id = $1 AND action = 'PLAN_CHANGED'
        ORDER BY created_at`,
      [restaurant.id]
    );
    return rows.map(r => r.details);
  };

  /** Emite una factura de verdad, que es lo que hace «en uso» a la capacidad. */
  async function issueOne() {
    const table = await fixtures.createTable(restaurant.id, { name: `P${++seq}` });
    const bill = await fixtures.createBill({
      restaurantId: restaurant.id, tableId: table.id, totalDue: 0, totalDueVes: 0
    });
    await db.query('UPDATE bills SET vat_bps = 1600, service_charge_bps = 0 WHERE id = $1', [bill.id]);
    const product = await db.query(
      `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active, tax_category)
       VALUES ($1, $2, 10000, 'VES', true, 'TAXABLE') RETURNING id`,
      [restaurant.id, `Plato-${++seq}`]
    );
    const { bill: updated } = await billItems.addItem({
      restaurantId: restaurant.id, billId: bill.id, productId: product.rows[0].id, quantity: 1
    });
    const payment = await db.query(
      `INSERT INTO payments (restaurant_id, bill_id, amount_ves, payment_method, payer_type, status)
       VALUES ($1, $2, $3, 'CASH', 'STAFF', 'SUCCEEDED') RETURNING id`,
      [restaurant.id, bill.id, updated.total_due]
    );
    return invoicing.issueForPayment({
      restaurantId: restaurant.id, billId: bill.id, paymentId: payment.rows[0].id, provider: 'own'
    });
  }

  it('subir de plan borra la fecha de prueba', async () => {
    // Dejarla puesta le enseñaría «tu prueba termina el día tal» a un
    // restaurante que acaba de pagar. Es la mitad de lo que el UPDATE a mano
    // se dejaba siempre.
    const out = await plans.change({ restaurantId: restaurant.id, tier: 'ENTERPRISE' });

    assert.equal(out.after.plan_tier, 'ENTERPRISE');
    assert.equal((await tierOf()).trial_ends_at, null);
    assert.ok(out.changes.gained.includes('fiscalInvoicing'),
      'y gana lo único que la API exige de verdad');
  });

  it('volver a TRIAL con --trial-days pone la fecha', async () => {
    await plans.change({ restaurantId: restaurant.id, tier: 'PRO' });
    assert.equal((await tierOf()).trial_ends_at, null);

    await plans.change({ restaurantId: restaurant.id, tier: 'TRIAL', trialDays: 14 });
    const now = await tierOf();
    assert.ok(now.trial_ends_at, 'hay fecha otra vez');
    const days = (new Date(now.trial_ends_at) - Date.now()) / 86400000;
    assert.ok(days > 13 && days < 15, `esperaba ~14 días, salieron ${days}`);
  });

  it('cada cambio deja de dónde venía y adónde fue', async () => {
    await plans.change({ restaurantId: restaurant.id, tier: 'PRO', note: 'contrato firmado' });
    await plans.change({ restaurantId: restaurant.id, tier: 'ENTERPRISE' });

    const rows = await auditRows();
    assert.equal(rows.length, 2);
    assert.deepEqual([rows[0].from, rows[0].to], ['TRIAL', 'PRO']);
    assert.equal(rows[0].note, 'contrato firmado');
    assert.deepEqual([rows[1].from, rows[1].to], ['PRO', 'ENTERPRISE']);
    assert.ok(rows[1].gained.includes('fiscalInvoicing'));
  });

  it('sin rastro no hay cambio', async () => {
    /*
     * La razón de no usar `logAudit`.
     *
     * `logAudit` se traga sus fallos, y colgando de una petición eso está bien:
     * un apunte que no se escribe no puede tumbar el cobro que lo provocó.
     * Aquí es al revés. No hay petición, no hay usuario, no hay nada más que
     * registre que alguien cambió el plan de un cliente -- **el apunte es el
     * único registro**. Si no se puede escribir, el plan no se mueve.
     *
     * Eso es lo que comprueba esta prueba, y conviene ser exacto: comprueba la
     * **garantía**, no el mecanismo. Que el apunte vaya en la misma transacción
     * es cómo se cumple, pero un apunte escrito por fuera que reventara también
     * abortaría el cambio, así que esto no distinguiría las dos formas. Lo que
     * descarta la de fuera está en `plans.js`: se autobloquea contra el
     * `FOR UPDATE` por la clave ajena de `audit_logs` a `restaurants`.
     *
     * Se provoca con un trigger que revienta al insertar, que es la única forma
     * honesta de llegar aquí: sin él la prueba comprobaría que el apunte existe
     * cuando todo va bien, que es justo el caso que no hace falta comprobar.
     */
    await db.query(`
      CREATE OR REPLACE FUNCTION plan_test_break_audit() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'auditoría caída'; END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER plan_test_break_audit BEFORE INSERT ON audit_logs
        FOR EACH ROW EXECUTE FUNCTION plan_test_break_audit();
    `);

    try {
      await assert.rejects(
        plans.change({ restaurantId: restaurant.id, tier: 'ENTERPRISE' }),
        /auditoría caída/
      );
      assert.equal((await tierOf()).plan_tier, 'TRIAL',
        'el plan volvió atrás con el apunte que no se pudo escribir');
      assert.deepEqual(await auditRows(), [],
        'y tampoco quedó un apunte huérfano contando un cambio que no ocurrió');
    } finally {
      await db.query('DROP TRIGGER IF EXISTS plan_test_break_audit ON audit_logs');
      await db.query('DROP FUNCTION IF EXISTS plan_test_break_audit()');
    }
  });

  it('bajar de plan quitándole lo que ya usa se para', async () => {
    // Es el cambio que cuesta dinero: el restaurante tiene documentos emitidos
    // y dejaría de poder emitir el siguiente, a mitad de servicio.
    await plans.change({ restaurantId: restaurant.id, tier: 'ENTERPRISE' });
    const issued = await issueOne();
    assert.equal(issued.status, 'ISSUED');

    await assert.rejects(
      plans.change({ restaurantId: restaurant.id, tier: 'PRO' }),
      err => {
        assert.equal(err.code, 'PLAN_DOWNGRADE_BLOCKED');
        assert.equal(err.details.breaking[0].capability, 'fiscalInvoicing');
        assert.match(err.details.breaking[0].detail, /ya ha emitido 1 factura/);
        return true;
      }
    );
    assert.equal((await tierOf()).plan_tier, 'ENTERPRISE', 'y no se movió');
    assert.deepEqual((await auditRows()).map(r => r.to), ['ENTERPRISE'],
      'el intento rechazado no deja apunte: no cambió nada');
  });

  it('con force baja igual, y queda dicho que se forzó', async () => {
    await plans.change({ restaurantId: restaurant.id, tier: 'ENTERPRISE' });
    await issueOne();

    const out = await plans.change({ restaurantId: restaurant.id, tier: 'PRO', force: true });
    assert.equal(out.after.plan_tier, 'PRO');

    const last = (await auditRows()).at(-1);
    assert.equal(last.forced, true);
    assert.equal(last.breaking[0].capability, 'fiscalInvoicing');
  });

  it('bajar sin haber usado nada no necesita force', async () => {
    // Quitar una capacidad que el restaurante no ha estrenado no le quita nada,
    // así que pedir una confirmación ahí sólo enseñaría a saltársela siempre.
    //
    // Restaurante propio a propósito: las pruebas de arriba dejan facturas
    // emitidas, que es justo la condición que este caso necesita **no** tener.
    // Compartiendo el de la suite, esto pasaría o fallaría según el orden.
    const virgin = await fixtures.createRestaurant({ name: 'Plan Virgin' });
    try {
      await plans.change({ restaurantId: virgin.id, tier: 'ENTERPRISE' });
      const out = await plans.change({ restaurantId: virgin.id, tier: 'STARTER' });

      assert.equal(out.after.plan_tier, 'STARTER');
      assert.ok(out.changes.lost.includes('fiscalInvoicing'));
      assert.equal(out.breaking.length, 0);
    } finally {
      await db.query('DELETE FROM audit_logs WHERE restaurant_id = $1', [virgin.id]);
      await fixtures.destroyRestaurant(virgin.id);
    }
  });

  it('un plan que no existe se rechaza antes de escribir', async () => {
    // El CHECK de la migración 012 también lo pararía, pero como un 500 sin
    // decir cuáles son los válidos.
    await assert.rejects(
      plans.change({ restaurantId: restaurant.id, tier: 'PREMIUM' }),
      err => {
        assert.equal(err.code, 'VALIDATION_FAILED');
        assert.deepEqual(err.details.allowed, ['TRIAL', 'STARTER', 'PRO', 'ENTERPRISE']);
        return true;
      }
    );
    assert.equal((await tierOf()).plan_tier, 'TRIAL');
  });

  it('se encuentra por RIF, que es lo que uno tiene a mano', async () => {
    await db.query("UPDATE restaurants SET rif = 'J123456784' WHERE id = $1", [restaurant.id]);
    const found = await plans.find({ restaurantId: null, rif: 'J123456784' });
    assert.equal(found.id, restaurant.id);
  });

  it('y por el correo del dueño, que es lo que uno tiene de verdad', async () => {
    /*
     * Quien vende un plan sabe con quién habló, no el UUID de su restaurante.
     * Sin esta forma, el primer paso volvía a ser una consulta a mano contra la
     * base -- justo lo que el servicio existe para quitar de en medio.
     *
     * Sin ambigüedad posible: `users_email_unique_idx` hace el correo único en
     * toda la plataforma y no sólo dentro de un restaurante, porque si no el
     * login no sabría a cuál entrar.
     */
    await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, 'Duena.Plan@Example.com', 'x', 'OWNER')`,
      [restaurant.id]
    );
    try {
      const found = await plans.find({ email: 'duena.plan@example.com' });
      assert.equal(found.id, restaurant.id, 'y sin distinguir mayúsculas');
    } finally {
      await db.query('DELETE FROM users WHERE restaurant_id = $1', [restaurant.id]);
    }
  });

  it('un correo que no es de nadie no devuelve un restaurante cualquiera', async () => {
    // El `OR` de tres ramas es justo la forma de consulta donde un parámetro
    // nulo puede acabar casando con todo. Aquí se comprueba que no.
    await assert.rejects(
      plans.find({ email: 'nadie@example.com' }),
      err => {
        assert.equal(err.code, 'RESTAURANT_NOT_FOUND');
        return true;
      }
    );
  });
});
