const { test } = require('node:test');
const assert = require('node:assert/strict');

const entitlements = require('../src/services/entitlements');

/**
 * Los derechos por plan.
 *
 * Lo que estas pruebas protegen no es la tabla -- una tabla se lee -- sino las
 * dos reglas que la rodean y que son fáciles de romper sin darse cuenta:
 *
 *   1. que «lo que incluye un plan» y «lo que la API rechaza» son conjuntos
 *      distintos, y que el segundo no crezca por accidente hasta quitarle a un
 *      restaurante algo que ya estaba usando;
 *   2. que una capacidad mal escrita reviente en vez de rechazar en silencio.
 */

test('el suelo del producto está en todos los planes, incluido el de prueba', () => {
  // Un QR que no funciona no es la prueba de nada.
  for (const tier of entitlements.TIERS) {
    const caps = entitlements.capabilitiesFor(tier);
    assert.equal(caps.bills, true, `${tier} tiene que poder abrir cuentas`);
    assert.equal(caps.splitting, true, `${tier} tiene que poder repartir`);
    assert.equal(caps.declaredMobilePayment, true, `${tier} tiene que poder cobrar`);
  }
});

test('la facturación fiscal es sólo del plan de arriba', () => {
  assert.deepEqual(entitlements.tiersOffering('fiscalInvoicing'), ['ENTERPRISE']);
  assert.equal(entitlements.tierIncludes('PRO', 'fiscalInvoicing'), false);
  assert.equal(entitlements.tierIncludes('ENTERPRISE', 'fiscalInvoicing'), true);
});

test('capabilitiesFor responde por toda capacidad, no sólo por las que sí', () => {
  // Una ausencia obliga al cliente a tratar «no está» como «no puede», y eso se
  // rompe en cuanto se añade una capacidad que ese cliente aún no conoce.
  const caps = entitlements.capabilitiesFor('TRIAL');
  assert.deepEqual(Object.keys(caps).sort(), [...entitlements.CAPABILITIES].sort());
  for (const value of Object.values(caps)) assert.equal(typeof value, 'boolean');
});

test('sólo se rechaza de verdad lo que está en ENFORCED', () => {
  /*
   * La prueba que impide un apagón.
   *
   * Todo lo demás de la tabla ya está desplegado y en uso por restaurantes que
   * están en el plan en el que están. Meterlo en ENFORCED empezaría a
   * devolverles 403 en mitad de un servicio. Que eso pase tiene que ser una
   * decisión de precio tomada a propósito -- y romper esta prueba es la forma
   * de enterarse de que se está tomando.
   */
  assert.deepEqual([...entitlements.ENFORCED], ['fiscalInvoicing']);

  // Un TRIAL no compra C2P, y aun así la API no se lo quita hoy.
  assert.equal(entitlements.tierIncludes('TRIAL', 'c2pCharge'), false, 'no lo incluye');
  assert.equal(entitlements.isAllowed('TRIAL', 'c2pCharge'), true, 'y aun así no se le corta');

  // La que sí se rechaza.
  assert.equal(entitlements.isAllowed('PRO', 'fiscalInvoicing'), false);
  assert.equal(entitlements.isAllowed('ENTERPRISE', 'fiscalInvoicing'), true);
});

test('una capacidad mal escrita revienta, en vez de rechazar a todo el mundo', () => {
  // El modo de fallo que esto evita: una errata en la puerta de una ruta se
  // leería como «nadie puede hacer esto», que es una caída disfrazada de
  // norma de precios.
  assert.throws(() => entitlements.tierIncludes('PRO', 'fiscalInvoicng'), /Unknown capability/);
  assert.throws(() => entitlements.tiersOffering('noExiste'), /Unknown capability/);
  // Incluso por el camino en el que no se rechaza nada: si no validara el
  // nombre, una errata pasaría inadvertida para siempre.
  assert.throws(() => entitlements.isAllowed('PRO', 'c2pChrge'), /Unknown capability/);
});

test('cada capacidad nombra tiers que existen, y ninguna se queda sin nadie', () => {
  for (const [name, tiers] of Object.entries(entitlements.INCLUDED)) {
    assert.ok(tiers.length > 0, `${name} no la tiene nadie: es una capacidad muerta`);
    for (const tier of tiers) {
      assert.ok(entitlements.TIERS.includes(tier), `${name} nombra un plan inexistente: ${tier}`);
    }
  }
});

test('los planes son acumulativos: ninguno quita lo que da el anterior', () => {
  // Si un escalón superior perdiera algo del inferior, subir de plan sería un
  // castigo y la tabla de precios mentiría.
  for (let i = 1; i < entitlements.TIERS.length; i++) {
    const lower = entitlements.capabilitiesFor(entitlements.TIERS[i - 1]);
    const higher = entitlements.capabilitiesFor(entitlements.TIERS[i]);
    for (const name of entitlements.CAPABILITIES) {
      if (lower[name]) {
        assert.equal(higher[name], true,
          `${entitlements.TIERS[i]} pierde ${name}, que sí trae ${entitlements.TIERS[i - 1]}`);
      }
    }
  }
});
