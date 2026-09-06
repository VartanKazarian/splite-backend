const { getRateFor } = require('./fx');
const { parseRate, applyRate, toMinor } = require('./money');
const { ApiError } = require('../errors');

/**
 * Lo que hace falta para abrir una cuenta antes de tocar la base de datos.
 *
 * Vivía dentro de `routes/bills.js`, que es donde se abría la única cuenta que
 * se abría. Ahora hay dos caminos que abren una -- el mesero tomando nota y el
 * comensal pidiendo desde el QR -- y la regla de "sin tasa no hay cuenta" no
 * puede existir dos veces: la segunda copia es la que un día se queda sin
 * arreglar.
 */

/**
 * Freezes the rate the bill will settle at.
 *
 * Taken when the bill is opened, not when it is first paid, so the total a
 * diner is quoted cannot move underneath them while they eat. A VES menu needs
 * no conversion and is recorded as an identity rate rather than a null, so
 * every bill can state what it settled at.
 */
async function snapshotFx(menuCurrency, totalDueMinorUnits) {
  if (menuCurrency === 'VES') {
    return { totalDueVes: String(totalDueMinorUnits), rate: '1', source: 'IDENTITY', valueDate: null };
  }

  const fx = await getRateFor(menuCurrency);
  if (!fx) {
    // Fail closed: a foreign-currency bill without a rate has no settleable
    // total, and inventing one is what the FX service exists to prevent. This
    // can only stop a bill being opened; payments on existing bills use the
    // rate already frozen on them.
    throw new ApiError(
      'FX_UNAVAILABLE',
      `No exchange rate is available for ${menuCurrency}, so the bill cannot be opened`,
      { currency: menuCurrency }
    );
  }

  const scaled = parseRate(fx.rate);
  return {
    totalDueVes: applyRate(toMinor(totalDueMinorUnits), scaled, 'Bill total in VES').toString(),
    rate: String(fx.rate),
    source: fx.source,
    valueDate: fx.valueDate ?? null
  };
}

module.exports = { snapshotFx };
