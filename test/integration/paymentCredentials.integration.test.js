const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const providerConfigs = require('../../src/payments/providerConfigs');

/**
 * Las credenciales de pago de un restaurante, frente a otro restaurante.
 *
 * Es el recurso más sensible del sistema -- las claves con las que se le cobra
 * a la gente -- y era el único de su clase sin prueba de aislamiento. La
 * unitaria cubre el cifrado y el anillo de claves; lo que sólo una base de
 * datos puede enseñar es que dos inquilinos que guardan credenciales del
 * **mismo proveedor** no se pisan.
 *
 * **Y aquí la amenaza no es la que parece.** No hay id de restaurante en
 * ninguna ruta: `/account/payment-providers/:provider` sólo lleva el proveedor,
 * y el inquilino sale de `req.user.restaurantId`, o sea del token. No existe un
 * parámetro que manipular, así que el IDOR clásico no es ni expresable. Lo que
 * sí puede fallar -- y es lo que se prueba -- es la otra mitad: que una escritura
 * o un borrado de A alcancen la fila de B porque la clave de la tabla no
 * incluya el restaurante, o porque una consulta filtre sólo por proveedor.
 *
 * Se ataca el servicio y no la ruta a propósito: la ruta ya está atada al token
 * por construcción, y lo que hay que demostrar es que la capa de abajo no se
 * fía de que quien la llame lo haya hecho bien.
 */
describe('payment credentials, across tenants', { skip }, () => {
  let a;
  let b;

  const CRED_A = {
    merchantId: 'M-AAA', clientId: 'C-AAA', secretKey: 'secreto-de-A',
    integratorId: 'I-AAA', terminalId: 'T-AAA'
  };
  const CRED_B = {
    merchantId: 'M-BBB', clientId: 'C-BBB', secretKey: 'secreto-de-B',
    integratorId: 'I-BBB', terminalId: 'T-BBB'
  };
  const PROVIDER = 'MERCANTIL';

  before(async () => {
    a = await fixtures.createRestaurant({ name: 'Credenciales A' });
    b = await fixtures.createRestaurant({ name: 'Credenciales B' });
    await providerConfigs.putCredentials({ restaurantId: a.id, provider: PROVIDER, credentials: CRED_A });
    await providerConfigs.putCredentials({ restaurantId: b.id, provider: PROVIDER, credentials: CRED_B });
  });

  after(async () => {
    await db.query('DELETE FROM payment_provider_configs WHERE restaurant_id = ANY($1)', [[a?.id, b?.id]]);
    await fixtures.destroyRestaurant(a?.id);
    await fixtures.destroyRestaurant(b?.id);
    await db.close();
  });

  /** Lo que de verdad devuelve el servicio: `{ credentials, enabled }`. */
  const load = (restaurantId) =>
    providerConfigs.loadCredentials({ restaurantId, provider: PROVIDER });

  it('cada uno carga las suyas, con el mismo proveedor', async () => {
    const forA = await load(a.id);
    const forB = await load(b.id);
    assert.equal(forA.credentials.secretKey, CRED_A.secretKey);
    assert.equal(forB.credentials.secretKey, CRED_B.secretKey);
    assert.notEqual(forA.credentials.secretKey, forB.credentials.secretKey);
  });

  it('el listado de A no menciona a B', async () => {
    const rows = await providerConfigs.listConfigs(a.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every(r => r.restaurant_id === a.id),
      'listConfigs devolvió una fila de otro restaurante');
  });

  it('sobrescribir las de A no toca las de B', async () => {
    await providerConfigs.putCredentials({
      restaurantId: a.id,
      provider: PROVIDER,
      credentials: { ...CRED_A, secretKey: 'secreto-de-A-rotado' }
    });
    const forB = await load(b.id);
    assert.equal(forB.credentials.secretKey, CRED_B.secretKey, 'la escritura de A alcanzó la fila de B');
  });

  it('borrar las de A deja las de B en pie', async () => {
    await providerConfigs.deleteConfig({ restaurantId: a.id, provider: PROVIDER });
    // Sin fila, el servicio lanza; no devuelve null.
    await assert.rejects(() => load(a.id), err => err.code === 'PAYMENT_PROVIDER_UNKNOWN');

    const forB = await load(b.id);
    assert.ok(forB, 'el borrado de A se llevó por delante la fila de B');
    assert.equal(forB.credentials.secretKey, CRED_B.secretKey);
  });

  it('habilitar el proveedor de A no habilita el de B', async () => {
    await providerConfigs.putCredentials({ restaurantId: a.id, provider: PROVIDER, credentials: CRED_A });
    await providerConfigs.markValidated({ restaurantId: a.id, provider: PROVIDER, enable: true });

    const [rowB] = await providerConfigs.listConfigs(b.id);
    assert.ok(rowB, 'B debería seguir teniendo su fila');
    assert.notEqual(rowB.enabled, true, 'marcar validado en A habilitó el proveedor de B');
  });
});
