const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { requirePlan } = require('../../src/middleware/plan');
const entitlements = require('../../src/services/entitlements');

/**
 * La puerta del plan, contra una base de datos de verdad.
 *
 * Se prueba aquí y no con la base simulada porque lo que hay que demostrar es
 * justo lo que una simulación daría por bueno: que el escalón se lee de la
 * fila en el momento de la petición, y que cambiarlo surte efecto ya -- no
 * cuando caduque un token de quince minutos.
 */
describe('la puerta del plan', { skip }, () => {
  let restaurant;

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: 'Plan Gate Tenant' });
  });

  after(async () => {
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  const setTier = tier =>
    db.query('UPDATE restaurants SET plan_tier = $1 WHERE id = $2', [tier, restaurant.id]);

  /** Ejecuta el middleware y devuelve el error que le pasa a `next`, o null. */
  const run = (capability) => new Promise((resolve, reject) => {
    const req = { user: { restaurantId: restaurant.id } };
    requirePlan(capability)(req, {}, err => (err instanceof Error || err == null
      ? resolve(err ?? null)
      : reject(new Error('next recibió algo que no es un error'))));
  });

  it('deja pasar al plan que sí incluye la capacidad', async () => {
    await setTier('ENTERPRISE');
    assert.equal(await run('fiscalInvoicing'), null);
  });

  it('rechaza al que no, y dice qué plan lo arreglaría', async () => {
    await setTier('PRO');
    const err = await run('fiscalInvoicing');

    assert.ok(err, 'PRO no compra facturación fiscal');
    assert.equal(err.code, 'PLAN_UPGRADE_REQUIRED');
    // Un cliente al que sólo se le dice «no» tiene que adivinar cuál de los
    // tres escalones de arriba es el que sirve. La respuesta ya está en la
    // tabla, así que va en el error.
    assert.equal(err.details.currentTier, 'PRO');
    assert.deepEqual(err.details.requiredTiers, ['ENTERPRISE']);
    assert.equal(err.details.capability, 'fiscalInvoicing');
  });

  it('el cambio de plan surte efecto en la siguiente petición, no al caducar el token', async () => {
    // La razón de leer de la base y no del JWT. Un restaurante que mejora su
    // plan tiene que poder facturar ahora, y uno cuyo plan terminó tiene que
    // dejar de hacerlo ahora.
    await setTier('PRO');
    assert.ok(await run('fiscalInvoicing'), 'antes: rechazado');

    await setTier('ENTERPRISE');
    assert.equal(await run('fiscalInvoicing'), null, 'después: pasa, sin token nuevo');

    await setTier('STARTER');
    assert.ok(await run('fiscalInvoicing'), 'y al bajar, vuelve a rechazar');
  });

  it('no corta lo que no está en ENFORCED, ni siquiera en el plan de prueba', async () => {
    /*
     * El apagón que esto evita.
     *
     * Un TRIAL no compra C2P, y hay restaurantes en TRIAL cobrando por C2P
     * ahora mismo. Describirlo como no incluido es correcto; quitárselo a
     * mitad de un servicio es otra cosa, y tiene que ser una decisión de
     * precio tomada a propósito.
     */
    await setTier('TRIAL');
    assert.equal(entitlements.tierIncludes('TRIAL', 'c2pCharge'), false, 'no lo incluye');
    assert.equal(await run('c2pCharge'), null, 'y aun así la puerta lo deja pasar');
  });

  it('una capacidad mal escrita revienta al montar la ruta, no al primer cliente', () => {
    // Si fallara en la petición, una errata desplegada rechazaría a todo el
    // mundo y parecería una norma de precios en vez de una caída.
    assert.throws(() => requirePlan('fiscalInvoicng'), /Unknown capability/);
  });

  it('un restaurante que ya no existe es 404, no un pase libre', async () => {
    const ghost = { user: { restaurantId: '00000000-0000-4000-8000-000000000000' } };
    const err = await new Promise(resolve =>
      requirePlan('fiscalInvoicing')(ghost, {}, e => resolve(e ?? null)));

    assert.ok(err, 'sin fila no se puede afirmar que tenga plan');
    assert.equal(err.code, 'RESTAURANT_NOT_FOUND');
  });
});
