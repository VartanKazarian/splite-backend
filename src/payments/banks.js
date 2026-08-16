/**
 * Venezuelan banks, by their four-digit code.
 *
 * The code is the thing everything else hangs off. It prefixes every account
 * number, Mercantil's C2P body carries it as `destination_bank_id`, and it is
 * what will decide which integration module handles a given restaurant --
 * because there is no such thing as "the bank API" here. Each bank exposes its
 * own, with its own credentials, its own field encryption and its own idea of
 * what a payment reference is.
 *
 * `integration` is that mapping, and it is deliberately honest about being
 * mostly empty: `null` means we have no module for that bank and a restaurant
 * banking there can be configured but cannot be charged through us. Listing a
 * bank is not a claim that it works.
 *
 * ---------------------------------------------------------------------------
 * THIS LIST IS UNVERIFIED. Before anything relies on it in production it must
 * be checked against Sudeban's official register. It is written from memory,
 * the codes are load-bearing -- a wrong one sends a diner's money to another
 * institution -- and "it looked right" is not a standard that survives contact
 * with somebody's payroll. Treat every entry as a draft until confirmed.
 * ---------------------------------------------------------------------------
 */

const BANKS = Object.freeze({
  '0102': { name: 'Banco de Venezuela', integration: null },
  '0104': { name: 'Venezolano de Crédito', integration: null },
  '0105': { name: 'Mercantil', integration: null },
  '0108': { name: 'Provincial', integration: null },
  '0114': { name: 'Bancaribe', integration: null },
  '0115': { name: 'Exterior', integration: null },
  '0128': { name: 'Banco Caroní', integration: null },
  '0134': { name: 'Banesco', integration: null },
  '0137': { name: 'Sofitasa', integration: null },
  '0138': { name: 'Banco Plaza', integration: null },
  '0151': { name: 'BFC Banco Fondo Común', integration: null },
  '0156': { name: '100% Banco', integration: null },
  '0157': { name: 'DelSur', integration: null },
  '0163': { name: 'Banco del Tesoro', integration: null },
  '0166': { name: 'Banco Agrícola de Venezuela', integration: null },
  '0168': { name: 'Bancrecer', integration: null },
  '0169': { name: 'Mi Banco', integration: null },
  '0171': { name: 'Banco Activo', integration: null },
  '0172': { name: 'Bancamiga', integration: null },
  '0174': { name: 'Banplus', integration: null },
  '0175': { name: 'Banco Bicentenario', integration: null },
  '0177': { name: 'Banfanb', integration: null },
  '0191': { name: 'Banco Nacional de Crédito', integration: null }
});

const CODES = Object.freeze(Object.keys(BANKS));

/** A known bank code, or null. Format alone is not enough: 0999 is well-formed. */
function lookup(code) {
  const key = String(code ?? '').trim();
  return BANKS[key] ?? null;
}

const isKnown = code => lookup(code) !== null;

/**
 * Whether a bank can actually be charged through, as opposed to merely named.
 *
 * Kept separate from `isKnown` so the difference is visible in the code that
 * asks. A restaurant may record any known bank as its payee -- that is where
 * diners send money, and they send it whether or not we have an API -- but only
 * a bank with a module can be part of an in-app payment.
 */
const hasIntegration = code => Boolean(lookup(code)?.integration);

/**
 * The bank a 20-digit account number belongs to, read from its first four
 * digits. A cheap consistency check on data somebody typed twice.
 */
const bankOfAccount = accountNumber => String(accountNumber ?? '').trim().slice(0, 4);

/** For a picker, ordered by name rather than by code. */
const list = () => CODES
  .map(code => ({ code, name: BANKS[code].name, chargeable: hasIntegration(code) }))
  .sort((a, b) => a.name.localeCompare(b.name, 'es'));

module.exports = { BANKS, CODES, lookup, isKnown, hasIntegration, bankOfAccount, list };
