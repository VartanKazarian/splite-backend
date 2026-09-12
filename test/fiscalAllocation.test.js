const { test } = require('node:test');
const assert = require('node:assert/strict');

const { allocatePayment, outstandingOf, stateFromLines } = require('../src/services/fiscalAllocation');
const { applyBps } = require('../src/services/money');

/**
 * El reparto fiscal.
 *
 * La exigencia real de emitir N facturas sobre una mesa no es emitirlas: es que
 * sumen la cuenta **exactamente**, y por cada alícuota. Un bolívar de más de
 * base declarada no es un redondeo, es una declaración falsa.
 *
 * Casi todo aquí son propiedades sobre secuencias generadas, no ejemplos. Un
 * ejemplo elegido a mano demuestra que el caso elegido a mano funciona; lo que
 * hace falta demostrar es que no hay una secuencia de pagos que descuadre.
 */

const vatOf = (base, bps) => applyBps(base, bps, 'IVA');

/** Un generador reproducible: una prueba que falla un día de cada mil no sirve. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Paga la cuenta entera en trozos al azar y devuelve las facturas emitidas. */
function payOff(state, random) {
  const invoices = [];
  let current = state;
  let guard = 0;

  while (outstandingOf(current) > 0n) {
    if (++guard > 500) throw new Error('la cuenta no se cierra');
    const left = outstandingOf(current);
    // Un trozo al azar de lo que queda, nunca cero, y el último se lo lleva todo.
    const draw = BigInt(Math.floor(random() * Number(left))) + 1n;
    const amount = draw > left ? left : draw;

    const { invoice, remaining } = allocatePayment(current, amount);
    invoices.push(invoice);
    current = remaining;
  }
  return { invoices, final: current };
}

/** Comprueba las tres igualdades que no pueden fallar nunca. */
function assertExact(state, invoices, final, label) {
  // 1. Cada bolsa queda vacía.
  for (const group of final.groups) {
    assert.equal(group.baseMinor, 0n, `${label}: base sin declarar al ${group.vatBps}bps`);
    assert.equal(group.vatMinor, 0n, `${label}: IVA sin declarar al ${group.vatBps}bps`);
  }
  assert.equal(final.serviceMinor, 0n, `${label}: servicio sin declarar`);

  // 2. Por cada alícuota, la suma de las facturas es la de la cuenta.
  state.groups.forEach((group, index) => {
    const base = invoices.reduce((sum, inv) => sum + inv.groups[index].baseMinor, 0n);
    const vat = invoices.reduce((sum, inv) => sum + inv.groups[index].vatMinor, 0n);
    assert.equal(base, group.baseMinor, `${label}: base al ${group.vatBps}bps`);
    assert.equal(vat, group.vatMinor, `${label}: IVA al ${group.vatBps}bps`);
  });

  // 3. Cada factura vale exactamente lo que se pagó, y nada es negativo.
  for (const inv of invoices) {
    const parts = inv.groups.reduce((s, g) => s + g.baseMinor + g.vatMinor, 0n) + inv.serviceMinor;
    assert.equal(parts, inv.totalMinor, `${label}: una factura no suma sus partes`);
    for (const g of inv.groups) {
      assert.ok(g.baseMinor >= 0n && g.vatMinor >= 0n, `${label}: componente negativo`);
    }
    assert.ok(inv.serviceMinor >= 0n, `${label}: servicio negativo`);
  }
}

test('cien repartos al azar suman la cuenta al céntimo, por alícuota', () => {
  const random = rng(20260912);
  let checked = 0;

  for (let run = 0; run < 100; run++) {
    // Cartas con mezcla de tasas, importes feos y servicio a veces.
    const lines = [];
    const lineCount = 1 + Math.floor(random() * 6);
    for (let i = 0; i < lineCount; i++) {
      const rate = [0, 800, 1600, 3100][Math.floor(random() * 4)];
      lines.push({ vatBps: rate, subtotalMinor: BigInt(1 + Math.floor(random() * 99999)) });
    }
    const subtotal = lines.reduce((s, l) => s + l.subtotalMinor, 0n);
    const serviceMinor = random() < 0.5 ? applyBps(subtotal, 1000, 'servicio') : 0n;

    const state = stateFromLines(lines, { serviceMinor, vatOf });
    const { invoices, final } = payOff(state, random);

    assertExact(state, invoices, final, `run ${run}`);
    checked++;
  }

  assert.equal(checked, 100, 'las cien se comprobaron de verdad');
});

test('el caso de tres a partes iguales, que es donde se pierde el céntimo', () => {
  // 100,00 al 16% entre tres. Repartir por porcentaje redondeando cada uno da
  // 33,33 x 3 = 99,99 y deja un céntimo sin declarar. Sobre el resto, no.
  const lines = [{ vatBps: 1600, subtotalMinor: 10000n }];
  const state = stateFromLines(lines, { vatOf });
  assert.equal(outstandingOf(state), 11600n);

  const invoices = [];
  let current = state;
  for (const amount of [3866n, 3867n, 3867n]) {
    const step = allocatePayment(current, amount);
    invoices.push(step.invoice);
    current = step.remaining;
  }

  assert.equal(outstandingOf(current), 0n, 'no queda nada por declarar');
  assertExact(state, invoices, current, 'tres iguales');

  const base = invoices.reduce((s, i) => s + i.groups[0].baseMinor, 0n);
  const vat = invoices.reduce((s, i) => s + i.groups[0].vatMinor, 0n);
  assert.equal(base, 10000n, 'la base declarada es la de la cuenta');
  assert.equal(vat, 1600n, 'y el IVA también');
});

test('un exento en la cuenta se declara como su propio grupo, con IVA cero', () => {
  const state = stateFromLines([
    { vatBps: 1600, subtotalMinor: 50000n },
    { vatBps: 0, subtotalMinor: 20000n }
  ], { vatOf });

  assert.equal(state.groups.length, 2, 'dos alícuotas, dos grupos');
  const exento = state.groups.find(g => g.vatBps === 0);
  assert.equal(exento.baseMinor, 20000n);
  assert.equal(exento.vatMinor, 0n, 'un exento no genera IVA que repartir');

  const random = rng(7);
  const { invoices, final } = payOff(state, random);
  assertExact(state, invoices, final, 'con exento');

  // Y ninguna factura le inventa IVA al grupo exento.
  for (const inv of invoices) {
    const line = inv.groups.find(g => g.vatBps === 0);
    assert.equal(line.vatMinor, 0n, 'el exento nunca paga IVA, en ninguna factura');
  }
});

test('una sola factura por el total declara exactamente la cuenta', () => {
  // El caso mayoritario: una mesa, un pagador. No puede ser el que se rompa por
  // pasar por un motor de reparto.
  const state = stateFromLines([{ vatBps: 1600, subtotalMinor: 2553n }],
    { serviceMinor: 255n, vatOf });

  const { invoice, remaining } = allocatePayment(state, outstandingOf(state));
  assert.equal(outstandingOf(remaining), 0n);
  assert.equal(invoice.groups[0].baseMinor, 2553n);
  assert.equal(invoice.groups[0].vatMinor, 408n, '16% de 2553 redondeado, igual que la cuenta');
  assert.equal(invoice.serviceMinor, 255n);
  assert.equal(invoice.totalMinor, 3216n);
});

test('pagar de a un céntimo tampoco descuadra', () => {
  // El caso extremo del modelo de resto: muchísimas facturas diminutas. Es donde
  // un reparto por porcentaje acumularía error hasta perder bolívares.
  const state = stateFromLines([{ vatBps: 1600, subtotalMinor: 500n }], { vatOf });
  const total = outstandingOf(state);

  const invoices = [];
  let current = state;
  for (let i = 0n; i < total; i++) {
    const step = allocatePayment(current, 1n);
    invoices.push(step.invoice);
    current = step.remaining;
  }

  assert.equal(invoices.length, Number(total));
  assertExact(state, invoices, current, 'céntimo a céntimo');
});

test('no deja pagar más de lo que queda por declarar', () => {
  const state = stateFromLines([{ vatBps: 1600, subtotalMinor: 1000n }], { vatOf });
  assert.throws(() => allocatePayment(state, outstandingOf(state) + 1n), /exceeds/);
  assert.throws(() => allocatePayment(state, -1n), /negative/);
});

test('un pago de cero no emite nada y no mueve el estado', () => {
  const state = stateFromLines([{ vatBps: 1600, subtotalMinor: 1000n }], { vatOf });
  const { invoice, remaining } = allocatePayment(state, 0n);
  assert.equal(invoice.totalMinor, 0n);
  assert.equal(outstandingOf(remaining), outstandingOf(state));
});

test('el IVA de cada factura no se aleja de su propia base más de un céntimo', () => {
  /*
   * El compromiso, fijado en una prueba en vez de en un comentario.
   *
   * Una factura suelta declara un IVA que puede quedar a un céntimo de aplicarle
   * la alícuota a su base: es inevitable cuando un importe elegido por el
   * pagador tiene que partirse en dos enteros. Lo que no se compromete son las
   * sumas, y eso lo fijan las otras pruebas. Si esta cota empeorara, la factura
   * empezaría a ser rara de leer y habría que enterarse.
   */
  const random = rng(99);
  for (let run = 0; run < 40; run++) {
    const state = stateFromLines(
      [{ vatBps: 1600, subtotalMinor: BigInt(100 + Math.floor(random() * 50000)) }],
      { vatOf }
    );
    const { invoices } = payOff(state, random);

    for (const inv of invoices) {
      const { baseMinor, vatMinor } = inv.groups[0];
      const ideal = applyBps(baseMinor, 1600, 'IVA');
      const drift = vatMinor > ideal ? vatMinor - ideal : ideal - vatMinor;
      assert.ok(drift <= 1n, `IVA ${vatMinor} contra ${ideal} sobre base ${baseMinor}`);
    }
  }
});
