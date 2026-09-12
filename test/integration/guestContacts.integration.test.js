const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const contacts = require('../../src/services/guestContacts');

/**
 * El contacto del comensal, y la política de consentimiento.
 *
 * Todo lo que se afirma aquí es sobre la diferencia entre dar un correo y
 * aceptar publicidad. Son dos finalidades, y el modo de fallo caro es
 * silencioso: una lista que crece con gente que nunca dijo que sí, y de la que
 * nadie se entera hasta que alguien reclama.
 */
describe('contactos del comensal', { skip }, () => {
  let restaurant;
  let seq = 0;

  before(async () => { restaurant = await fixtures.createRestaurant({ name: 'Contacts Tenant' }); });

  after(async () => {
    if (restaurant) await db.query('DELETE FROM guest_contacts WHERE restaurant_id = $1', [restaurant.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const email = () => `diner-${++seq}@example.com`;
  const save = (opts) => contacts.upsert({ restaurantId: restaurant.id, source: 'TEST', ...opts });

  it('dar el correo para la factura NO apunta a publicidad', async () => {
    /*
     * La afirmación central.
     *
     * Si esto se rompiera, cada comensal que quisiera su factura acabaría en
     * una lista de promociones sin haberlo pedido, y nadie se enteraría hasta
     * la primera reclamación.
     */
    const row = await save({ email: email() });
    assert.equal(row.marketing_consent, false);
    assert.equal(row.consent_at, null, 'sin consentimiento no hay fecha que enseñar');
  });

  it('marcar la casilla sí lo apunta, con fecha y procedencia', async () => {
    const address = email();
    const row = await save({ email: address, marketingConsent: true });
    assert.equal(row.marketing_consent, true);
    assert.ok(row.consent_at, 'un booleano suelto no defiende nada: hace falta cuándo');

    const { rows } = await db.query(
      'SELECT consent_source FROM guest_contacts WHERE restaurant_id = $1 AND email = $2',
      [restaurant.id, address]
    );
    assert.equal(rows[0].consent_source, 'TEST', 'y desde dónde');
  });

  it('volver sin marcar no retira lo que ya se aceptó', async () => {
    // No mandar el campo es «no digo nada», no «me doy de baja». Para eso está
    // la baja explícita.
    const address = email();
    await save({ email: address, marketingConsent: true });
    const again = await save({ email: address });
    assert.equal(again.marketing_consent, true);
  });

  it('una baja no se reactiva por volver a dejar el correo', async () => {
    /*
     * El caso que de verdad importa, y el menos obvio.
     *
     * Alguien se da de baja, vuelve a cenar meses después y pide su factura.
     * Si eso lo devolviera a la lista, la baja no habría servido de nada -- y
     * quien la pidió recibiría publicidad otra vez sin haber dicho que sí.
     */
    const address = email();
    await save({ email: address, marketingConsent: true });
    await contacts.withdraw({ restaurantId: restaurant.id, email: address });

    const back = await save({ email: address, marketingConsent: true });
    assert.equal(back.marketing_consent, false, 'sigue de baja: no ha vuelto a aceptar nada');
  });

  it('la baja conserva la fila, que es la prueba', async () => {
    // Borrarla perdería la constancia de que el consentimiento existió, que es
    // justo lo que habría que enseñar si alguien reclama.
    const address = email();
    await save({ email: address, marketingConsent: true });
    const out = await contacts.withdraw({ restaurantId: restaurant.id, email: address });

    assert.ok(out, 'la fila sigue ahí');
    assert.ok(out.withdrawn_at, 'con la fecha de la baja');
  });

  it('el mismo correo en dos restaurantes son dos respuestas distintas', async () => {
    /*
     * El contacto es del restaurante, no de Splite. Alguien puede querer saber
     * de un local y no del otro, y cruzarlos sería usar el dato para algo que
     * nadie autorizó.
     */
    const other = await fixtures.createRestaurant({ name: 'Otro Tenant' });
    try {
      const address = email();
      await save({ email: address, marketingConsent: true });
      await contacts.upsert({
        restaurantId: other.id, email: address, marketingConsent: false, source: 'TEST'
      });

      const mine = await contacts.listConsented({ restaurantId: restaurant.id, limit: 100 });
      const theirs = await contacts.listConsented({ restaurantId: other.id, limit: 100 });

      assert.ok(mine.some(c => c.email === address), 'aquí sí dijo que sí');
      assert.ok(!theirs.some(c => c.email === address), 'y allí no');
    } finally {
      await db.query('DELETE FROM guest_contacts WHERE restaurant_id = $1', [other.id]);
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('mayúsculas y espacios no crean un segundo contacto ni una segunda baja', async () => {
    const address = `Mixed-${++seq}@Example.COM`;
    await save({ email: address, marketingConsent: true });
    await save({ email: `  ${address.toLowerCase()}  ` });

    const { rows } = await db.query(
      'SELECT count(*)::INT AS n FROM guest_contacts WHERE restaurant_id = $1 AND lower(email) = lower($2)',
      [restaurant.id, address]
    );
    assert.equal(rows[0].n, 1, 'uno solo, o una baja dejaría al otro vivo');
  });

  it('la lista que usa el restaurante sólo trae a quien dijo que sí', async () => {
    const yes = email();
    const no = email();
    const gone = email();
    await save({ email: yes, marketingConsent: true });
    await save({ email: no });
    await save({ email: gone, marketingConsent: true });
    await contacts.withdraw({ restaurantId: restaurant.id, email: gone });

    const list = await contacts.listConsented({ restaurantId: restaurant.id, limit: 200 });
    const emails = list.map(c => c.email);
    assert.ok(emails.includes(yes));
    assert.ok(!emails.includes(no), 'quien sólo quería su factura no está');
    assert.ok(!emails.includes(gone), 'ni quien se dio de baja');
  });

  it('la base no admite un consentimiento sin fecha', async () => {
    // La afirmación que habría que defender la impone la base, no la costumbre.
    await assert.rejects(
      () => db.query(
        `INSERT INTO guest_contacts (restaurant_id, email, marketing_consent)
         VALUES ($1, $2, true)`,
        [restaurant.id, email()]
      ),
      err => {
        assert.equal(err.code, '23514');
        assert.equal(err.constraint, 'guest_contacts_consent_dated');
        return true;
      }
    );
  });
});
