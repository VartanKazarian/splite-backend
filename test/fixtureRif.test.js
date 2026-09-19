const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, 'integration', 'helpers', 'rif.js');

/** Una instancia recién cargada del módulo, como la de otro proceso. */
function freshInstance() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

/**
 * Lo que garantiza el RIF del fixture.
 *
 * El runner arranca un proceso por fichero de pruebas y `restaurants_rif_unique_idx`
 * es único en toda la tabla, así que la garantía no es «único dentro de este
 * fichero»: es que dos procesos que arranquen a la vez no coincidan. Recargar el
 * módulo con el reloj congelado reproduce exactamente eso -- estado del módulo a
 * cero y mismo milisegundo -- sin tener que lanzar procesos de verdad.
 */
test('el RIF del fixture', async (t) => {
  await t.test('no lo deciden ni el reloj ni el estado del módulo', () => {
    const real = Date.now;
    Date.now = () => 1_700_000_000_000;
    try {
      // La fórmula anterior (reloj + contador del módulo) daba aquí el mismo
      // valor las mil veces; ése es el fallo que esta prueba deja clavado.
      const seen = new Set();
      for (let i = 0; i < 50; i++) seen.add(freshInstance().newRif());
      assert.equal(seen.size, 50);
    } finally {
      Date.now = real;
    }
  });

  await t.test('tiene la forma de un RIF y cabe en la columna', () => {
    const { newRif } = freshInstance();
    for (let i = 0; i < 100; i++) {
      const rif = newRif();
      assert.match(rif, /^J\d{9}$/);
      assert.ok(rif.length <= 20, `${rif} no cabe en VARCHAR(20)`);
    }
  });
});
