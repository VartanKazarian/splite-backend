const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validateBody, declareClaimSchema } = require('../src/middleware/schemas');

/**
 * Qué campo falló, en un dato y no en una frase.
 *
 * Un formulario que quiere marcar en rojo la casilla equivocada necesita el
 * nombre del campo. `details.fields` son los mensajes de Joi, y no sirven para
 * eso: salen en tres formas distintas y una de ellas no nombra el campo en
 * absoluto. El comensal que se equivocaba de teléfono al declarar un pago móvil
 * leía "Revisa los datos." y ninguna casilla marcada -- con cinco casillas
 * delante y sin ninguna pista de cuál.
 */

/** Ejecuta el middleware y devuelve el error que le pasa a `next`. */
function run(schema, body) {
  let captured = null;
  // En el camino bueno el middleware llama a `next()` sin argumentos, así que
  // lo que llega es `undefined`: se normaliza para poder afirmar "no hubo error".
  validateBody(schema)({ body }, {}, err => { captured = err ?? null; });
  return captured;
}

test('fieldPaths names every field that failed, including the one whose message does not', () => {
  const err = run(declareClaimSchema, {
    amountVes: '0',
    reference: 'ab',
    phoneOrigin: '5454544545',
    bankOrigin: '9999',
    idOrigin: 'XX1'
  });

  assert.ok(err, 'five bad fields should not validate');
  assert.equal(err.code, 'VALIDATION_FAILED');
  assert.deepEqual(
    [...err.details.fieldPaths].sort(),
    ['amountVes', 'bankOrigin', 'idOrigin', 'phoneOrigin', 'reference']
  );

  /*
   * La razón de existir de la lista, en una sola afirmación.
   *
   * El mensaje de `idOrigin` es propio y empieza por "must be a cédula o RIF":
   * no lleva el nombre del campo ni entre comillas ni sin ellas. Cualquier
   * cliente que dedujera el campo leyendo el mensaje marcaría otra casilla o
   * ninguna. Si alguien vuelve a redactar ese mensaje, esta prueba sigue
   * pasando; si alguien quita `fieldPaths`, no.
   */
  const idMessage = err.details.fields.find(m => m.includes('cédula'));
  assert.ok(idMessage, 'el mensaje de idOrigin debería seguir ahí');
  assert.ok(
    !idMessage.includes('idOrigin'),
    'si el mensaje ya nombra el campo, esta prueba dejó de cubrir lo que cubría'
  );
  assert.ok(err.details.fieldPaths.includes('idOrigin'));
});

test('fieldPaths does not repeat a field that broke two rules at once', () => {
  // "ab" es corta **y** tiene letras: dos entradas en `fields`, un solo campo
  // que marcar. Repetirlo haría que un cliente pintara el mismo error dos veces.
  const err = run(declareClaimSchema, { amountVes: '100', reference: 'ab' });

  assert.ok(err.details.fields.filter(m => m.includes('reference')).length >= 2);
  assert.deepEqual(err.details.fieldPaths, ['reference']);
});

test('a valid claim passes, so the guard is not simply refusing everything', () => {
  assert.equal(
    run(declareClaimSchema, {
      amountVes: '5915994',
      reference: '8787878778',
      phoneOrigin: '04141234567'
    }),
    null
  );
});
