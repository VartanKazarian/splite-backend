const test = require('node:test');
const assert = require('node:assert/strict');

const { parseRif } = require('../src/services/fiscalIssuer');

/**
 * Lo que el RIF del emisor acepta y lo que avisa.
 *
 * La asimetría es lo que se fija aquí: la forma se rechaza y el dígito
 * verificador sólo se avisa. Está razonada en `utils/rif` y en el servicio --
 * rechazar por un cálculo que nunca se contrastó contra RIF reales deja a un
 * restaurante de verdad sin poder facturar por un fallo nuestro.
 */
test('el RIF del emisor', async (t) => {
  await t.test('se guarda normalizado, escriba como escriba quien lo teclee', () => {
    for (const written of ['J-12345678-4', 'j123456784', ' J 12345678 4 ', 'J.12345678.4']) {
      assert.equal(parseRif(written).rif, 'J123456784', written);
    }
  });

  await t.test('rechaza lo que no tiene forma de RIF', () => {
    for (const bad of ['', '12345678', 'J-1234-4', 'X123456784', 'J1234567890', 'hola']) {
      assert.throws(() => parseRif(bad), err => err.code === 'FISCAL_RIF_MALFORMED', `«${bad}»`);
    }
  });

  await t.test('avisa del dígito verificador, pero no rechaza por él', () => {
    // Este no cuadra. Se acepta igual, y el aviso viaja en checksumOk para que
    // la pantalla lo diga en voz alta.
    const wrong = parseRif('J-12345678-9');
    assert.equal(wrong.rif, 'J123456789');
    assert.equal(wrong.checksumOk, false);

    assert.equal(parseRif('J-12345678-4').checksumOk, true);
  });

  await t.test('admite los otros tipos de contribuyente, no sólo el jurídico', () => {
    // Un restaurante suele ser J, pero una persona natural con RIF V factura
    // igual, y rechazarla sería inventar una regla que el SENIAT no tiene.
    for (const letter of ['V', 'E', 'J', 'P', 'G']) {
      assert.doesNotThrow(() => parseRif(`${letter}-12345678-0`), letter);
    }
  });
});
