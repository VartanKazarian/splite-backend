const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalise, parseAmount, parseDate, normaliseId } = require('../src/services/bankMovementNormalizer');

/**
 * Leer un movimiento de cualquier banco sin inventar nada.
 *
 * Lo caro aquí es leer mal un importe: «1.234» tomado como uno con veintitrés
 * es un movimiento mil veces menor que casaría con otro aviso. Por eso cada
 * formato ambiguo tiene su prueba, y lo que no se entiende se rechaza.
 */
describe('normalizar movimientos del banco', () => {
  it('importes en formato venezolano, anglosajón y sin separadores', () => {
    const cases = {
      '1.234,56': '123456',
      '1234,56': '123456',
      '1,234.56': '123456',
      '1234.56': '123456',
      '1.234': '123400',
      '1.234.567,8': '123456780',
      '12,5': '1250',
      '120': '12000',
      'Bs 1.234,56': '123456',
      'Bs.S 23.628,99': '2362899',
      ' 23 628,99 ': '2362899'
    };
    for (const [raw, expected] of Object.entries(cases)) {
      const r = parseAmount(raw);
      assert.equal(r.ok, true, `${raw}: ${r.reason}`);
      assert.equal(r.value, expected, raw);
    }
  });

  it('un débito no es un pago recibido', () => {
    for (const raw of ['-1.234,56', '(1.234,56)', '1.234,56-']) {
      assert.deepEqual(parseAmount(raw), { ok: false, reason: 'debit' }, raw);
    }
  });

  it('lo que no se entiende se rechaza en vez de adivinarlo', () => {
    assert.equal(parseAmount('1.23.4').ok, false);
    assert.equal(parseAmount('12,345,6').ok, false);
    assert.equal(parseAmount('abc').ok, false);
    assert.equal(parseAmount('0,00').ok, false, 'un movimiento de cero no es un pago');
    assert.deepEqual(parseAmount('1,234.567'), { ok: false, reason: 'amount_precision' });
  });

  it('fechas del banco en hora de Caracas', () => {
    assert.equal(parseDate('23/09/2026'), '2026-09-23T16:00:00.000Z');
    assert.equal(parseDate('23-09-2026 21:30'), '2026-09-24T01:30:00.000Z', 'las 21:30 de Caracas son la 01:30 UTC');
    assert.equal(parseDate('2026-09-23T10:00:00Z'), '2026-09-23T10:00:00.000Z');
    assert.equal(parseDate('ayer'), null, 'una fecha ilegible es null, no un error');
  });

  it('cédulas y RIF', () => {
    assert.equal(normaliseId('V-12.345.678'), 'V12345678');
    assert.equal(normaliseId('j-30123456-7'), 'J301234567');
    assert.equal(normaliseId('12345678'), '12345678');
    assert.equal(normaliseId('xx'), null);
  });

  it('una fila completa, y sus rechazos con motivo', () => {
    const ok = normalise({
      reference: '0012-3456-7890', amount: '1.234,56', date: '23/09/2026',
      phoneOrigin: '+58 414-123-4567', idOrigin: 'V-12.345.678', bankCode: '0105',
      description: '  PAGO MOVIL RECIBIDO  '
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.movement, {
      reference: '001234567890',
      amountMinor: '123456',
      occurredAt: '2026-09-23T16:00:00.000Z',
      phoneOrigin: '584141234567',
      idOrigin: 'V12345678',
      bankCode: '0105',
      description: 'PAGO MOVIL RECIBIDO'
    });
    assert.deepEqual(normalise({ reference: '12', amount: '10' }), { ok: false, reason: 'reference' });
    assert.deepEqual(normalise({ reference: '12345678', amount: '-10' }), { ok: false, reason: 'debit' });
    assert.equal(normalise({ reference: '12345678', amountMinor: '2500' }).movement.amountMinor, '2500');
    assert.deepEqual(normalise({ reference: '12345678', amountMinor: '25.00' }), { ok: false, reason: 'amount' });
    assert.deepEqual(normalise(null), { ok: false, reason: 'shape' });
  });
});
