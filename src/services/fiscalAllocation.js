const { allocate } = require('./split');

/**
 * Repartir una cuenta en N facturas que suman exactamente la cuenta.
 *
 * La exigencia fiscal de emitir varias facturas sobre una misma mesa no está en
 * emitirlas: está en que **sumen**. Ni un céntimo de base imponible declarado
 * de más, ni uno de menos, y lo mismo por cada alícuota. Si las N facturas de
 * la mesa 12 declaran un bolívar más de base que la cuenta que se cobró, eso no
 * es un error de redondeo, es una declaración falsa.
 *
 * Lo que hace difícil el problema aquí es el modelo de reparto que Splite ya
 * tiene: cada comensal paga **una cantidad libre sobre lo que queda**. No se
 * sabe cuántos van a ser, ni cuánto va a poner cada uno, hasta que lo ponen. No
 * se puede repartir por pesos conocidos de antemano, que es como lo resuelve
 * casi todo el mundo.
 *
 * La salida es la misma forma que ya tiene el producto: **secuencial y sobre el
 * resto**. La cuenta lleva una bolsa por cada componente declarable -- una por
 * alícuota, más el servicio -- y cada pago se lleva un trozo de cada bolsa. El
 * último pago se lleva justo lo que quede. La suma es exacta por construcción y
 * no por comprobación posterior, que es la misma decisión que ya gobierna
 * `splitEngine`.
 *
 * ## Por qué las bolsas y no un porcentaje
 *
 * Lo evidente sería: el comensal paga el 30% de la cuenta, luego declara el 30%
 * de cada base. Redondear cada componente por separado descuadra: tres al 33,3%
 * no suman el 100%, y el descuadre cae en la declaración. Con bolsas, lo que se
 * reparte es siempre *lo que falta*, así que el error no se acumula: se
 * consume.
 *
 * ## El redondeo que queda, dicho claramente
 *
 * Dentro de un grupo de alícuota, el trozo que se lleva un pago se parte en
 * base e IVA con el mismo reparto de resto mayor. Eso hace que la suma de las
 * bases sea exacta y la suma de los IVA sea exacta -- que es lo que se declara
 * --, pero el IVA de **una** factura suelta puede quedar a un céntimo de
 * aplicarle la alícuota a su propia base. Es inevitable en cuanto un importe
 * elegido por el pagador tiene que partirse en dos sumandos enteros, y es el
 * compromiso que toma cualquier facturación prorrateada. Lo que no se
 * compromete es el total: cada factura suma exactamente lo que esa persona
 * pagó.
 *
 * Cuando sí se sabe qué consumió cada uno -- el modo «Lo mío» -- no hace falta
 * prorratear nada y las líneas se calculan de las suyas. Este módulo es para
 * los otros tres modos, que son los que no lo saben.
 */

/**
 * El estado declarable pendiente de una cuenta.
 *
 * `groups` es una bolsa por alícuota, cada una con la base y el IVA que quedan
 * por declarar. `serviceMinor` es el servicio, que va aparte porque no es un
 * impuesto y no pertenece a ninguna alícuota.
 *
 * La propina no está aquí a propósito: no es del restaurante, no lleva IVA y no
 * se declara en esta factura.
 */

/** Suma de todo lo que queda por declarar. */
function outstandingOf(state) {
  const groups = state.groups.reduce((sum, g) => sum + g.baseMinor + g.vatMinor, 0n);
  return groups + state.serviceMinor;
}

/**
 * Reparte `amount` entre las bolsas, proporcionalmente a lo que queda en cada
 * una, y devuelve el desglose de una factura más el estado que queda.
 *
 * `amount` es lo que esa persona paga, y es dato: la factura vale eso, no lo
 * que salga de redondear. Por eso se reparte el importe entre las bolsas y no
 * al revés.
 *
 * El último pago vacía las bolsas exactamente, sin caso especial: cuando
 * `amount` iguala lo que queda, el reparto de resto mayor le asigna a cada
 * bolsa todo su contenido.
 */
function allocatePayment(state, amount) {
  const outstanding = outstandingOf(state);
  if (amount < 0n) throw new Error('A payment cannot be negative');
  if (amount > outstanding) {
    throw new Error(`Payment ${amount} exceeds the ${outstanding} left to declare`);
  }

  const emptyLines = state.groups.map(g => ({ vatBps: g.vatBps, baseMinor: 0n, vatMinor: 0n }));
  if (amount === 0n) {
    return { invoice: { groups: emptyLines, serviceMinor: 0n, totalMinor: 0n }, remaining: state };
  }

  // Una entrada por grupo, más el servicio al final. Las bolsas vacías se
  // quedan fuera del reparto: `allocate` exige pesos positivos, y una bolsa sin
  // nada no puede aportar nada.
  const buckets = [
    ...state.groups.map(g => g.baseMinor + g.vatMinor),
    state.serviceMinor
  ];
  const contributing = [];
  buckets.forEach((value, index) => { if (value > 0n) contributing.push(index); });

  const parts = new Array(buckets.length).fill(0n);
  const allocated = allocate(amount, contributing.map(i => buckets[i]));
  contributing.forEach((index, i) => { parts[index] = BigInt(allocated[i]); });

  const serviceShare = parts[buckets.length - 1];
  const groups = [];
  const remainingGroups = [];

  state.groups.forEach((group, index) => {
    const share = parts[index];
    const bucket = group.baseMinor + group.vatMinor;

    // Partir el trozo en base e IVA con el mismo reparto, de nuevo sobre lo que
    // queda de cada uno. Es lo que mantiene exactas *las dos* sumas.
    let baseShare = 0n;
    let vatShare = 0n;
    if (share > 0n && bucket > 0n) {
      if (group.baseMinor > 0n && group.vatMinor > 0n) {
        const [b, v] = allocate(share, [group.baseMinor, group.vatMinor]);
        baseShare = BigInt(b);
        vatShare = BigInt(v);
      } else if (group.vatMinor > 0n) {
        // Una alícuota del 0% -- un exento -- no tiene IVA que repartir, y todo
        // el trozo es base. El caso simétrico (base cero, IVA positivo) no
        // ocurre con tasas reales, y se trata igual por no depender de eso.
        vatShare = share;
      } else {
        baseShare = share;
      }
    }

    groups.push({ vatBps: group.vatBps, baseMinor: baseShare, vatMinor: vatShare });
    remainingGroups.push({
      vatBps: group.vatBps,
      baseMinor: group.baseMinor - baseShare,
      vatMinor: group.vatMinor - vatShare
    });
  });

  return {
    invoice: { groups, serviceMinor: serviceShare, totalMinor: amount },
    remaining: { groups: remainingGroups, serviceMinor: state.serviceMinor - serviceShare }
  };
}

/**
 * El estado inicial a partir de las líneas de una cuenta.
 *
 * Agrupa por la alícuota **congelada en cada línea** -- no por la general del
 * restaurante -- que es justo lo que la migración 038 hizo posible. Sin eso,
 * una cuenta con un exento dentro no se puede declarar.
 */
function stateFromLines(lines, { serviceMinor = 0n, vatOf } = {}) {
  const byRate = new Map();

  for (const line of lines) {
    const rate = Number(line.vatBps ?? 0);
    const base = BigInt(line.subtotalMinor);
    if (!byRate.has(rate)) byRate.set(rate, { vatBps: rate, baseMinor: 0n, vatMinor: 0n });
    byRate.get(rate).baseMinor += base;
  }

  // El IVA se calcula una vez por grupo sobre su base completa, que es
  // exactamente lo que hace `recalculateTotals` en la cuenta. Calcularlo aquí
  // de otra forma daría un total distinto del que se cobró, y la factura tiene
  // que declarar lo que se cobró.
  const groups = [...byRate.values()]
    .sort((a, b) => a.vatBps - b.vatBps)
    .map(group => ({ ...group, vatMinor: vatOf(group.baseMinor, group.vatBps) }));

  return { groups, serviceMinor: BigInt(serviceMinor) };
}

module.exports = { allocatePayment, outstandingOf, stateFromLines };
