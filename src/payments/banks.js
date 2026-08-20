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
 * STILL NOT OFFICIALLY SOURCED, but no longer only from memory. The table was
 * written from memory and has since been cross-checked against two independent
 * published lists, which agree with it on every code it already carried and
 * added three it did not. Where they disagreed it was about a bank's *name*,
 * not its code, and in both cases because the bank had been renamed.
 *
 * The authoritative document does exist -- the BCV publishes the institutions
 * active in the SCCE (ibp_activas_en_el_scce_2025.pdf) -- and we still have not
 * read it. Every attempt to reach a primary source has failed:
 *
 *   sudeban.gob.ve      no response (connection times out)
 *   www.sudeban.gob.ve  no response
 *   cbn.org.ve          no response
 *   bcv.org.ve          the SCCE participant list is published as a PDF, but
 *                       the host is blocked from this network; the pages that
 *                       are reachable describe the CCE without listing
 *                       participants
 *
 * Recorded so nobody repeats those dead ends. What is left is fetching that PDF
 * from a network that can reach bcv.org.ve, or asking a bank directly --
 * Mercantil hands its integrators the destination_bank_id list.
 *
 * A note on what a bank picker somewhere else proves. A live C2P checkout's
 * dropdown was compared against this table and offered eleven institutions we
 * do not list. Most are dead: Banco Industrial de Venezuela was ordered into
 * liquidation in 2016, and ABN AMRO, Banco Espírito Santo, Corp Banca and BOD
 * left the market years ago. A dropdown is a snapshot of whenever it was last
 * edited, so it is evidence a bank *existed*, not that it exists -- and adding
 * a dead bank here would let a restaurant configure a payee that can never
 * receive money. The live institutions it named that we were missing are in the
 * table below; the rest are deliberately not.
 *
 * What limits the damage meanwhile is the cross-check in `payoutSchema`: an
 * account number carries its own bank's code, so a wrong name-to-code pairing
 * here surfaces as a rejected form at configuration time rather than as
 * misdirected money. A restaurant picking "Banesco" whose account does not
 * start with the code recorded against Banesco cannot save.
 *
 * That leaves one hole it does not cover: two banks transposed in this list.
 * Both would validate and both would name the wrong institution to a bank API.
 * No payment path uses these codes today -- every `integration` is null -- so
 * the exposure is bounded until one does, and confirming the list is a
 * prerequisite for the first module rather than for the first restaurant.
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
  '0146': { name: 'Bangente', integration: null },
  '0151': { name: 'BFC Banco Fondo Común', integration: null },
  '0156': { name: '100% Banco', integration: null },
  '0157': { name: 'DelSur', integration: null },
  '0163': { name: 'Banco del Tesoro', integration: null },
  '0166': { name: 'Banco Agrícola de Venezuela', integration: null },
  '0168': { name: 'Bancrecer', integration: null },
  // Renamed from Mi Banco in 2025. The code did not move, so a payee configured
  // under the old name still works; only what a diner is shown changes.
  '0169': { name: 'R4, Banco Microfinanciero', integration: null },
  '0171': { name: 'Banco Activo', integration: null },
  '0172': { name: 'Bancamiga', integration: null },
  '0173': { name: 'Banco Internacional de Desarrollo', integration: null },
  '0174': { name: 'Banplus', integration: null },
  // Banco Bicentenario until July 2024, when it was renamed. Same institution,
  // same code -- worth knowing, because half the lists in circulation and every
  // restaurant owner still call it Bicentenario.
  '0175': { name: 'Banco Digital de los Trabajadores', integration: null },
  '0177': { name: 'Banfanb', integration: null },
  '0178': { name: 'N58 Banco Digital', integration: null },
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
