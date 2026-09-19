const { test } = require('node:test');
const assert = require('node:assert/strict');

const banks = require('../src/payments/banks');
const { declareClaimSchema } = require('../src/middleware/schemas');

/**
 * El desplegable de bancos y el validador, que tienen que ser la misma lista.
 *
 * `bankOrigin` es opcional y sólo corrobora un Pago Móvil declarado, pero
 * cuando viene el servidor exige un código de cuatro dígitos conocido. Mientras
 * el campo fue texto libre, escribir el nombre del banco -- lo natural --
 * devolvía 400 y **le impedía pagar al comensal**, por un campo que no tenía
 * obligación de rellenar. El mensaje de error decía «elígelo de la lista» y esa
 * lista no existía en ninguna pantalla a la que él llegara.
 *
 * Con el desplegable el valor inválido deja de ser posible, pero sólo mientras
 * las dos listas coincidan. Eso es lo que se fija aquí: si alguien añade un
 * banco a `BANKS` y el validador no lo admite -- o al revés -- el fallo vuelve
 * exactamente igual, y con la misma cara de «es opcional pero no te deja
 * pagar».
 */

const claim = (bankOrigin) => declareClaimSchema.validate({
  amountVes: '1000',
  reference: '12345678',
  ...(bankOrigin === undefined ? {} : { bankOrigin })
});

test('cada banco que se ofrece se acepta', () => {
  const offered = banks.list();
  assert.ok(offered.length > 0, 'la lista no puede estar vacía: sin ella no hay desplegable');

  const rejected = offered
    .map(bank => ({ bank, error: claim(bank.code).error }))
    .filter(({ error }) => error)
    .map(({ bank }) => `${bank.code} (${bank.name})`);

  assert.deepEqual(rejected, [],
    'el desplegable ofrece bancos que el servidor rechaza: el comensal no podría pagar');
});

test('no elegir banco sigue siendo válido, que es lo que hace opcional a un campo opcional', () => {
  assert.equal(claim(undefined).error, undefined);
});

test('el nombre del banco escrito a mano se rechaza, y por eso hace falta el desplegable', () => {
  // No es que esto deba aceptarse: es la prueba de por qué el campo no puede
  // ser una caja de texto. "Banesco" es lo que cualquiera escribiría.
  for (const typed of ['Banesco', 'banesco', 'BANESCO 0134', 'Mercantil']) {
    assert.ok(claim(typed).error, `${typed} debería rechazarse`);
  }
});

test('la lista va ordenada por nombre, que es como se busca el propio banco', () => {
  const names = banks.list().map(b => b.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, 'es')));
});
