const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { decide, claimShape } = require('../src/services/bankReconciliation');
const { matchClaim } = require('../src/payments/validation/match');

/**
 * La parte de la conciliación que se decide sin base de datos.
 *
 * Lo que importa es lo que el matcher, mirando un aviso cada vez, no puede
 * ver: que el dinero que llegó es parte + propina, y que un solo movimiento no
 * puede pagar dos avisos.
 */
const claim = (over = {}) => ({
  id: over.id ?? 'c1',
  amount_ves: '10000',
  tip_ves: '1000',
  declared_reference: '001234567890',
  metadata: { bankOrigin: '0105', phoneOrigin: '04141234567' },
  ...over
});

const movement = (over = {}) => ({
  id: over.id ?? 'm1',
  reference: '001234567890',
  amountMinor: '11000',
  bankCode: '0105',
  phoneOrigin: '584141234567',
  idOrigin: null,
  autoConfirm: false,
  ...over
});

describe('conciliar avisos con movimientos', () => {
  it('lo que llegó al banco es la parte más la propina', () => {
    assert.equal(claimShape(claim()).amountMinor, '11000');
    const [d] = decide([claim()], [movement()]);
    assert.equal(d.outcome, 'MATCHED');
    const [onlyShare] = decide([claim()], [movement({ amountMinor: '10000' })]);
    assert.equal(onlyShare.outcome, 'MISMATCH', 'la parte sola no es lo que se transfirió');
    assert.deepEqual(onlyShare.disagreements, ['amount']);
  });

  it('dos avisos con la referencia de un solo pago: ninguno se da por bueno', () => {
    // Lo que haría quien copia la referencia de otro comensal.
    const decisions = decide(
      [claim({ id: 'real' }), claim({ id: 'copia' })],
      [movement()]
    );
    assert.deepEqual(decisions.map(d => d.outcome), ['AMBIGUOUS', 'AMBIGUOUS']);
    assert.ok(decisions.every(d => d.movement === null));
  });

  it('cada aviso con su movimiento, aunque se parezcan', () => {
    const decisions = decide(
      [claim({ id: 'a' }), claim({ id: 'b', declared_reference: '009999999999' })],
      [movement({ id: 'ma' }), movement({ id: 'mb', reference: '009999999999' })]
    );
    assert.deepEqual(decisions.map(d => [d.claimId, d.outcome, d.movement?.id]),
      [['a', 'MATCHED', 'ma'], ['b', 'MATCHED', 'mb']]);
  });

  it('sin movimientos, nada casa', () => {
    assert.equal(decide([claim()], [])[0].outcome, 'NOT_FOUND');
  });
});

describe('el matcher y lo que el comensal no dijo', () => {
  const base = { reference: '001234567890', amountMinor: '12000' };

  it('un aviso sin banco ni teléfono casa con un movimiento que sí los trae', () => {
    // Antes «viene de otro banco» se afirmaba sin saber de qué banco venía el aviso.
    const res = matchClaim({ ...base, bankCode: null, phoneOrigin: null },
      [{ ...base, bankCode: '0134', phoneOrigin: '04121112233' }]);
    assert.equal(res.outcome, 'MATCHED');
  });

  it('si los dos lados traen la cédula, tiene que ser la misma', () => {
    const res = matchClaim({ ...base, idOrigin: 'V12345678' }, [{ ...base, idOrigin: 'V87654321' }]);
    assert.equal(res.outcome, 'MISMATCH');
    assert.deepEqual(res.disagreements, ['id']);
    const same = matchClaim({ ...base, idOrigin: 'V-12.345.678' }, [{ ...base, idOrigin: 'V12345678' }]);
    assert.equal(same.outcome, 'MATCHED');
  });
});
