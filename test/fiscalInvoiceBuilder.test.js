const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveLineBasis, buildDraft } = require('../src/services/fiscalInvoiceBuilder');
const { stateFromLines, outstandingOf } = require('../src/services/fiscalAllocation');
const { applyBps } = require('../src/services/money');

const vatOf = (base, bps) => applyBps(base, bps, 'IVA');

/**
 * De un pago a una factura.
 *
 * La regla de producto: si sabemos qué comió esta persona se factura lo que
 * comió, y si no se prorratea. Lo que estas pruebas fijan es cuándo se sabe de
 * verdad -- que es más estrecho de lo que parece -- y que elegir una forma u
 * otra **nunca** cambia lo que se declara.
 */

/* ------------------------------------------------- cuándo se sabe, y cuándo no */

test('reparto por producto y pago que cuadra: se factura lo que comió', () => {
  assert.equal(resolveLineBasis({
    splitMode: 'ITEMS', participantShareMinor: 4000n, paidMinor: 4000n,
    claimedItems: [{ id: 'a' }]
  }), 'ITEMISED');
});

test('reparto por producto pero pagando otra cosa: se prorratea', () => {
  /*
   * El caso que parece ITEMISED y no lo es.
   *
   * Alguien reclamó 400 y pone 250. Sus platos no son su factura: emitir las
   * líneas de los platos declararía 400 cuando se cobraron 250. Que el modo sea
   * por producto no basta -- tiene que cuadrar el importe.
   */
  assert.equal(resolveLineBasis({
    splitMode: 'ITEMS', participantShareMinor: 40000n, paidMinor: 25000n,
    claimedItems: [{ id: 'a' }]
  }), 'PRORATED');
});

test('partes iguales, a medias o la cuenta entera: se prorratea', () => {
  // Ninguno de estos tres modos registra quién consumió qué, así que no hay
  // líneas que poner. Es la respuesta honesta, no una limitación.
  for (const splitMode of ['EQUAL', 'CUSTOM', 'FULL']) {
    assert.equal(resolveLineBasis({
      splitMode, participantShareMinor: 1000n, paidMinor: 1000n, claimedItems: [{ id: 'a' }]
    }), 'PRORATED', `${splitMode} no sabe qué comió nadie`);
  }
});

test('reparto por producto sin líneas reclamadas: se prorratea', () => {
  assert.equal(resolveLineBasis({
    splitMode: 'ITEMS', participantShareMinor: 1000n, paidMinor: 1000n, claimedItems: []
  }), 'PRORATED');
});

/* --------------------------------------------------------------- construcción */

const billLines = [
  { name: 'Hamburguesa', quantity: 1, unitPriceMinor: 50000n, vatBps: 1600, subtotalMinor: 50000n },
  { name: 'Harina', quantity: 1, unitPriceMinor: 20000n, vatBps: 0, subtotalMinor: 20000n }
];

const freshState = () => stateFromLines(billLines, { serviceMinor: 7000n, vatOf });

test('la factura vale exactamente lo que se pagó, en las tres formas', () => {
  for (const lineBasis of ['ITEMISED', 'PRORATED', 'AGGREGATE']) {
    const state = freshState();
    const sourceLines = billLines.map(l => ({ ...l, shareMinor: l.subtotalMinor, fullMinor: l.subtotalMinor }));
    const draft = buildDraft({ state, paidMinor: 30000n, lineBasis, sourceLines, tableName: '12' });

    assert.equal(draft.totalMinor, 30000n, lineBasis);
    const parts = draft.subtotalMinor + draft.vatMinor + draft.serviceMinor;
    assert.equal(parts, 30000n, `${lineBasis}: el total es sus partes`);

    // Y las líneas suman el desglose, no algo parecido.
    const lineBase = draft.lines.reduce((s, l) => s + l.baseMinor, 0n);
    const lineVat = draft.lines.reduce((s, l) => s + l.vatMinor, 0n);
    assert.equal(lineBase, draft.subtotalMinor, `${lineBasis}: las líneas suman la base`);
    assert.equal(lineVat, draft.vatMinor, `${lineBasis}: las líneas suman el IVA`);
  }
});

test('quien sólo pidió el exento no declara IVA, y con prorrateo sí lo haría', () => {
  /*
   * La razón entera de distinguir ITEMISED de PRORATED, en una afirmación.
   *
   * Dos personas: una pidió la hamburguesa gravada, la otra la harina exenta.
   * Si a la segunda se le prorratea, declara IVA de algo que no consumió.
   */
  const exento = [{ ...billLines[1], shareMinor: 20000n, fullMinor: 20000n }];

  const itemised = buildDraft({
    state: freshState(), paidMinor: 20000n, lineBasis: 'ITEMISED', sourceLines: exento
  });
  assert.equal(itemised.vatMinor, 0n, 'lo suyo no lleva IVA');
  assert.equal(itemised.subtotalMinor + itemised.serviceMinor, 20000n);

  const prorated = buildDraft({
    state: freshState(), paidMinor: 20000n, lineBasis: 'PRORATED',
    sourceLines: billLines.map(l => ({ ...l, shareMinor: l.subtotalMinor, fullMinor: l.subtotalMinor }))
  });
  assert.ok(prorated.vatMinor > 0n, 'prorrateando sí declara IVA: no sabe qué comió');
});

test('mezclar formas en una misma mesa sigue declarando la cuenta exacta', () => {
  /*
   * El caso real: uno reparte por producto y paga lo suyo, y el resto van
   * pagando a ojo sobre lo que queda. Las formas se mezclan en la misma mesa y
   * la suma tiene que seguir siendo la cuenta.
   */
  const state = freshState();
  const total = outstandingOf(state);

  const suyo = [{ ...billLines[1], shareMinor: 20000n, fullMinor: 20000n }];
  const first = buildDraft({ state, paidMinor: 20000n, lineBasis: 'ITEMISED', sourceLines: suyo });

  const rest = billLines.map(l => ({ ...l, shareMinor: l.subtotalMinor, fullMinor: l.subtotalMinor }));
  const second = buildDraft({
    state: first.remaining, paidMinor: 30000n, lineBasis: 'PRORATED', sourceLines: rest
  });
  const third = buildDraft({
    state: second.remaining, paidMinor: outstandingOf(second.remaining),
    lineBasis: 'AGGREGATE', tableName: '12'
  });

  assert.equal(outstandingOf(third.remaining), 0n, 'no queda nada por declarar');

  const invoices = [first, second, third];
  assert.equal(invoices.reduce((s, i) => s + i.totalMinor, 0n), total, 'suman la cuenta');
  assert.equal(invoices.reduce((s, i) => s + i.vatMinor, 0n), vatOf(50000n, 1600),
    'y el IVA declarado es el de la cuenta, ni un céntimo más');
  assert.equal(invoices.reduce((s, i) => s + i.subtotalMinor, 0n), 70000n);
  assert.equal(invoices.reduce((s, i) => s + i.serviceMinor, 0n), 7000n);
});

test('la línea agregada dice que es una parte de una mesa, no un plato inventado', () => {
  const draft = buildDraft({
    state: freshState(), paidMinor: 10000n, lineBasis: 'AGGREGATE', tableName: '12'
  });
  assert.equal(draft.lines.length, 1);
  assert.match(draft.lines[0].description, /mesa 12/);
  assert.doesNotMatch(draft.lines[0].description, /Hamburguesa/);
});

test('una línea prorrateada lleva cantidad fraccionada, no redondeada', () => {
  // 0,338 hamburguesas es feo y es lo que significa prorratear. Redondear la
  // cantidad a 1 descuadraría el importe, que es lo único que no se puede tocar.
  const draft = buildDraft({
    state: freshState(), paidMinor: 30000n, lineBasis: 'PRORATED',
    sourceLines: billLines.map(l => ({ ...l, shareMinor: l.subtotalMinor, fullMinor: l.subtotalMinor }))
  });
  const burger = draft.lines.find(l => l.description === 'Hamburguesa');
  assert.ok(burger.quantityMilli < 1000n, `una fracción de plato, no ${burger.quantityMilli}`);
  assert.ok(burger.quantityMilli > 0n, 'pero nunca cero: una línea de cero no es una línea');
});

test('no deja facturar más de lo que queda por declarar', () => {
  const state = freshState();
  assert.throws(
    () => buildDraft({ state, paidMinor: outstandingOf(state) + 1n, lineBasis: 'AGGREGATE' }),
    /supera/
  );
});

test('una forma inventada revienta en vez de facturar algo raro', () => {
  assert.throws(
    () => buildDraft({ state: freshState(), paidMinor: 100n, lineBasis: 'A_OJO' }),
    /Unknown line basis/
  );
});
