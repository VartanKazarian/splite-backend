/**
 * Splits an exact integer amount of minor units.
 *
 * Dividing 7567 céntimos three ways leaves a remainder. Rounding each share
 * independently makes the parts sum to something other than the total, which
 * under `CHECK (amount_paid <= total_due)` means the last diner physically
 * cannot pay, and under an equality check the bill never closes.
 *
 * Largest-remainder (Hare quota) allocation: floor every share, then hand the
 * leftover units to the largest fractional remainders. The parts always sum to
 * exactly the total, and ties break by index so the result is deterministic.
 */
function allocate(totalMinorUnits, shares) {
  const total = BigInt(totalMinorUnits);
  if (total < 0n) throw new Error('Total must not be negative');
  if (!Array.isArray(shares) || shares.length === 0) throw new Error('At least one share is required');

  const weights = shares.map(value => {
    const weight = BigInt(value);
    if (weight <= 0n) throw new Error('Every share must be a positive integer');
    return weight;
  });

  const weightSum = weights.reduce((a, b) => a + b, 0n);
  const parts = weights.map(weight => (total * weight) / weightSum);
  const remainders = weights.map((weight, index) => ({ index, remainder: (total * weight) % weightSum }));

  let leftover = total - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : (b.remainder > a.remainder ? 1 : -1)
  );

  for (let i = 0; leftover > 0n; i++, leftover--) {
    parts[remainders[i % remainders.length].index] += 1n;
  }

  return parts.map(String);
}

/** Equal split across n diners. */
function splitEvenly(totalMinorUnits, diners) {
  if (!Number.isInteger(diners) || diners < 1) throw new Error('diners must be a positive integer');
  return allocate(totalMinorUnits, Array(diners).fill(1));
}

/**
 * VES minor units to a USD display string. Returns null when no rate is
 * locked — the caller omits the reference rather than showing a wrong number.
 */
function usdReference(minorUnitsVes, fxRate) {
  if (fxRate === null || fxRate === undefined) return null;
  const rate = Number(fxRate);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return (Number(minorUnitsVes) / 100 / rate).toFixed(2);
}

module.exports = { allocate, splitEvenly, usdReference };
