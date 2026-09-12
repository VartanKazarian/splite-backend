const { allocate } = require('./split');
const { allocatePayment, outstandingOf } = require('./fiscalAllocation');

/**
 * De un pago a una factura: qué líneas lleva y qué declara.
 *
 * La regla de arriba, que es de producto y no técnica: **si sabemos qué comió
 * esta persona, se factura lo que comió; si no, se prorratea.** Sólo un modo de
 * reparto lo sabe -- el de repartir por producto --, y sólo cuando esa persona
 * paga exactamente su parte. En los demás casos nadie sabe qué le tocó de la
 * mesa, y decir lo contrario en un documento fiscal sería inventarlo.
 *
 * Las tres formas quedan grabadas en el propio documento (`line_basis`), para
 * que dentro de dos años se sepa cómo se construyó y no haya que deducirlo:
 *
 *   ITEMISED   reparto por producto, y el pago cuadra con lo reclamado.
 *   PRORATED   las líneas de la cuenta, escaladas por lo que pagó.
 *   AGGREGATE  una sola línea, «consumo -- parte de la cuenta de la mesa N».
 *
 * ## Lo que hace que esto no descuadre
 *
 * Los importes **no** salen de las líneas. Salen del motor de reparto, que es
 * el que garantiza que las N facturas de una mesa sumen la cuenta al céntimo
 * por cada alícuota. Las líneas se construyen después, repartiendo dentro de
 * cada grupo lo que el motor ya asignó.
 *
 * Es al revés de lo que parece natural -- sumar las líneas y calcular el IVA --
 * y es a propósito: sumar líneas redondeadas por separado es exactamente donde
 * se pierde el céntimo que convierte un reparto en una declaración falsa.
 */

const LINE_BASIS = ['ITEMISED', 'PRORATED', 'AGGREGATE'];

/**
 * Cuál de las tres formas corresponde a este pago.
 *
 * `ITEMISED` pide dos cosas a la vez, y las dos importan. Que el reparto sea
 * por producto, porque es el único que registra quién reclamó qué. Y que el
 * importe pagado sea el de su parte: si alguien reclamó 400 y puso 250, sus
 * platos no son su factura, y emitir las líneas de los platos declararía algo
 * que no se cobró.
 */
function resolveLineBasis({ splitMode, participantShareMinor, paidMinor, claimedItems }) {
  if (
    splitMode === 'ITEMS' &&
    Array.isArray(claimedItems) && claimedItems.length > 0 &&
    participantShareMinor != null &&
    BigInt(participantShareMinor) === BigInt(paidMinor)
  ) {
    return 'ITEMISED';
  }
  return 'PRORATED';
}

/**
 * Los pesos con los que este pago tira de cada bolsa.
 *
 * Para una factura por producto, la composición de lo que reclamó: quien sólo
 * pidió algo exento no puede declarar IVA. Para el prorrateo no hay pesos y el
 * motor reparte por lo que queda, que es lo que significa prorratear.
 */
function compositionFor(groups, lines) {
  if (!lines) return null;
  const byRate = new Map(groups.map((group, index) => [group.vatBps, index]));
  const weights = new Array(groups.length + 1).fill(0n);

  for (const line of lines) {
    const index = byRate.get(Number(line.vatBps ?? 0));
    if (index !== undefined) weights[index] += BigInt(line.shareMinor);
  }
  // El servicio no pertenece a ninguna alícuota y se prorratea siempre: es del
  // local, no del plato, y no depende de qué pidió cada quien.
  return weights;
}

/**
 * Reparte un importe de grupo entre las líneas de ese grupo.
 *
 * Con `allocate` y no dividiendo: la suma de las líneas tiene que ser
 * exactamente lo que el motor asignó al grupo, y redondear cada línea por su
 * cuenta no lo garantiza.
 */
function spreadAcrossLines(amount, lines) {
  if (lines.length === 0 || amount === 0n) return lines.map(() => 0n);
  const weights = lines.map(l => BigInt(l.shareMinor));
  if (weights.every(w => w === 0n)) {
    return allocate(amount, lines.map(() => 1n)).map(BigInt);
  }
  const positive = [];
  lines.forEach((_, i) => { if (weights[i] > 0n) positive.push(i); });
  const parts = new Array(lines.length).fill(0n);
  const allocated = allocate(amount, positive.map(i => weights[i]));
  positive.forEach((index, k) => { parts[index] = BigInt(allocated[k]); });
  return parts;
}

/**
 * Construye la factura de un pago: sus líneas y su desglose por alícuota.
 *
 * `state` es lo que queda por declarar de la cuenta -- ver `fiscalAllocation` --
 * y `sourceLines` son las líneas candidatas, ya con su parte asignada:
 *
 *   ITEMISED   las que reclamó esa persona, con su porción de las compartidas.
 *   PRORATED   todas las de la cuenta, con su valor completo como peso.
 *   AGGREGATE  ninguna; se emite una sola línea descriptiva.
 */
function buildDraft({ state, paidMinor, lineBasis, sourceLines = [], tableName = null }) {
  if (!LINE_BASIS.includes(lineBasis)) throw new Error(`Unknown line basis: ${lineBasis}`);

  const amount = BigInt(paidMinor);
  if (amount > outstandingOf(state)) {
    throw new Error('El pago supera lo que queda por declarar en esta cuenta');
  }

  const composition = lineBasis === 'ITEMISED' ? compositionFor(state.groups, sourceLines) : null;
  const { invoice, remaining } = allocatePayment(state, amount, { composition });

  const taxes = invoice.groups
    .filter(group => group.baseMinor > 0n || group.vatMinor > 0n)
    .map(group => ({
      taxCategory: group.vatBps > 0 ? 'TAXABLE' : 'EXEMPT',
      vatBps: group.vatBps,
      baseMinor: group.baseMinor,
      vatMinor: group.vatMinor
    }));

  const lines = lineBasis === 'AGGREGATE'
    ? aggregateLine(invoice, tableName)
    : itemLines(invoice, state, sourceLines);

  return {
    lineBasis,
    lines,
    taxes,
    subtotalMinor: invoice.groups.reduce((sum, g) => sum + g.baseMinor, 0n),
    vatMinor: invoice.groups.reduce((sum, g) => sum + g.vatMinor, 0n),
    serviceMinor: invoice.serviceMinor,
    totalMinor: invoice.totalMinor,
    remaining
  };
}

/**
 * Una sola línea. El caso en que no se sabe nada y no se finge saberlo.
 *
 * Deliberadamente no dice «1 × Menú»: dice que esto es una parte de la cuenta
 * de una mesa, que es la verdad de lo que se cobró.
 */
function aggregateLine(invoice, tableName) {
  const base = invoice.groups.reduce((sum, g) => sum + g.baseMinor, 0n);
  return [{
    position: 1,
    description: tableName
      ? `Consumo — parte de la cuenta de la mesa ${tableName}`
      : 'Consumo — parte de una cuenta compartida',
    quantityMilli: 1000n,
    unitPriceMinor: base,
    taxCategory: invoice.groups.length === 1 && invoice.groups[0].vatBps === 0 ? 'EXEMPT' : 'TAXABLE',
    vatBps: invoice.groups.length === 1 ? invoice.groups[0].vatBps : 0,
    baseMinor: base,
    vatMinor: invoice.groups.reduce((sum, g) => sum + g.vatMinor, 0n)
  }];
}

/**
 * Una línea por plato, con lo que el motor asignó a su grupo repartido entre
 * ellas.
 *
 * La cantidad va en milésimas porque una línea prorrateada es una fracción de
 * plato: 0,338 hamburguesas. Un entero mentiría, y un decimal en coma flotante
 * no es dinero. Es fea de leer, y es exactamente lo que significa prorratear --
 * si esa fealdad no es aceptable en el papel, la respuesta es AGGREGATE, no
 * redondear la cantidad y descuadrar el importe.
 */
function itemLines(invoice, state, sourceLines) {
  const byRate = new Map(state.groups.map((group, index) => [group.vatBps, index]));
  const grouped = new Map();

  for (const line of sourceLines) {
    const rate = Number(line.vatBps ?? 0);
    if (!grouped.has(rate)) grouped.set(rate, []);
    grouped.get(rate).push(line);
  }

  const out = [];
  for (const [rate, lines] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    const index = byRate.get(rate);
    const group = index === undefined
      ? { baseMinor: 0n, vatMinor: 0n }
      : invoice.groups[index];

    const bases = spreadAcrossLines(group.baseMinor, lines);
    const vats = spreadAcrossLines(group.vatMinor, lines);

    lines.forEach((line, i) => {
      const full = BigInt(line.fullMinor ?? line.shareMinor);
      // La cantidad facturada como fracción de la del plato, en milésimas.
      const quantityMilli = full > 0n
        ? (BigInt(line.quantity ?? 1) * 1000n * bases[i]) / full
        : 1000n;
      out.push({
        position: out.length + 1,
        description: line.name,
        // Nunca cero: una línea de cantidad cero no es una línea. Si el reparto
        // le asignó menos de una milésima, se declara la mínima y el importe
        // -- que es lo que se declara -- sigue siendo el exacto.
        quantityMilli: quantityMilli > 0n ? quantityMilli : 1n,
        unitPriceMinor: BigInt(line.unitPriceMinor ?? 0),
        taxCategory: line.taxCategory ?? (rate > 0 ? 'TAXABLE' : 'EXEMPT'),
        vatBps: rate,
        baseMinor: bases[i],
        vatMinor: vats[i]
      });
    });
  }
  return out;
}

module.exports = { LINE_BASIS, resolveLineBasis, buildDraft, compositionFor };
