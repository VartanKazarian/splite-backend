const test = require('node:test');
const assert = require('node:assert/strict');

const { matchClaim, MIN_REFERENCE_DIGITS } = require('../src/payments/validation/match');

/** La reclamación de referencia para todas las pruebas: 120,00 Bs desde el 0105. */
const claim = {
  reference: '001234567890',
  amountMinor: '12000',
  bankCode: '0105',
  phoneOrigin: '04141234567'
};

/** Un movimiento que cuadra en todo, para ir estropeándolo campo a campo. */
const good = (over = {}) => ({
  reference: '001234567890',
  amountMinor: '12000',
  bankCode: '0105',
  phoneOrigin: '584141234567',
  ...over
});

test('emparejar un pago declarado con los movimientos del banco', async (t) => {
  await t.test('confirma cuando todo cuadra', () => {
    const res = matchClaim(claim, [good()]);
    assert.equal(res.outcome, 'MATCHED');
    assert.deepEqual(res.disagreements, []);
  });

  await t.test('le vale con los últimos dígitos, porque es lo que el banco devuelve', () => {
    // Bancos distintos devuelven referencias de largos distintos; exigir
    // igualdad literal dejaría la validación sin confirmar nunca.
    assert.equal(matchClaim(claim, [good({ reference: '34567890' })]).outcome, 'MATCHED');
  });

  await t.test('no se cree un sufijo demasiado corto', () => {
    const short = '7890';
    assert.ok(short.length < MIN_REFERENCE_DIGITS);
    // Ni MATCHED ni MISMATCH: con cuatro dígitos no se afirma nada del pago.
    assert.equal(matchClaim(claim, [good({ reference: short })]).outcome, 'NOT_FOUND');
  });

  await t.test('el monto no admite tolerancia, ni de un céntimo', () => {
    for (const amountMinor of ['11999', '12001', '1200000']) {
      const res = matchClaim(claim, [good({ amountMinor })]);
      assert.equal(res.outcome, 'MISMATCH', `${amountMinor} no debería confirmar`);
      assert.deepEqual(res.disagreements, ['amount']);
    }
  });

  await t.test('un pago desde otro banco no es este pago', () => {
    const res = matchClaim(claim, [good({ bankCode: '0102' })]);
    assert.equal(res.outcome, 'MISMATCH');
    assert.deepEqual(res.disagreements, ['bank']);
  });

  await t.test('el teléfono cuadra por los últimos cuatro, con prefijo o sin él', () => {
    for (const phoneOrigin of ['04141234567', '584141234567', '+58 414 123 45 67']) {
      assert.equal(matchClaim(claim, [good({ phoneOrigin })]).outcome, 'MATCHED', phoneOrigin);
    }
    const res = matchClaim(claim, [good({ phoneOrigin: '04149999999' })]);
    assert.equal(res.outcome, 'MISMATCH');
    assert.deepEqual(res.disagreements, ['phone']);
  });

  await t.test('lo que el banco no devuelve no se compara, y no estorba', () => {
    // No saber no es fallar: un banco que no informa el origen no debe impedir
    // una confirmación que la referencia y el monto ya sostienen.
    const res = matchClaim(claim, [{ reference: '001234567890', amountMinor: '12000' }]);
    assert.equal(res.outcome, 'MATCHED');
  });

  await t.test('sin nada parecido, no está', () => {
    assert.equal(matchClaim(claim, []).outcome, 'NOT_FOUND');
    assert.equal(matchClaim(claim, [good({ reference: '009999999999' })]).outcome, 'NOT_FOUND');
  });

  await t.test('con dos candidatas perfectas no elige: para', () => {
    // Dos comensales de la misma mesa, mismo monto, referencias que acaban
    // igual. Quedarse con la primera le abona a uno el pago del otro.
    const res = matchClaim(claim, [good(), good()]);
    assert.equal(res.outcome, 'AMBIGUOUS');
    assert.equal(res.movement, null);
    assert.equal(res.candidates, 2);
  });

  await t.test('entre varias que no cuadran, señala la menos discrepante', () => {
    const res = matchClaim(claim, [
      good({ amountMinor: '9900', bankCode: '0102', phoneOrigin: '04149999999' }),
      good({ amountMinor: '9900' })
    ]);
    assert.equal(res.outcome, 'MISMATCH');
    assert.deepEqual(res.disagreements, ['amount']);
  });

  await t.test('una sola buena entre ruido sí confirma', () => {
    const res = matchClaim(claim, [good({ amountMinor: '9900' }), good()]);
    assert.equal(res.outcome, 'MATCHED');
    assert.equal(res.movement.amountMinor, '12000');
  });
});
