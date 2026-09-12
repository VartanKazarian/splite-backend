/**
 * What a restaurant's plan lets it do.
 *
 * `restaurants.plan_tier` has existed since migration 012 and until now nothing
 * read it: `src/routes/account.js` said so in as many words, that the column
 * was reported so that something consulted it at all. A column nothing consults
 * is a column that quietly stops being true.
 *
 * This module turns it into an answer. Two things live here, and keeping them
 * apart is the whole point:
 *
 *   INCLUDED   what each tier is sold as including. Used to *describe* plans --
 *              on the account endpoint, and by a frontend deciding whether to
 *              offer a button or an upsell.
 *
 *   ENFORCED   the capabilities the API actually refuses without. Today that is
 *              fiscal invoicing and nothing else.
 *
 * Those two are not the same set, deliberately.
 *
 * Every other capability in the table below is already shipped and already in
 * use by restaurants on whatever tier they happen to sit on. Switching on
 * enforcement for those is a pricing decision with a dining room attached: a
 * TRIAL restaurant taking C2P payments tonight would start getting refusals
 * mid-service. That is a decision to make deliberately, with notice, and not a
 * side effect of wiring up a permission layer -- which is exactly the reasoning
 * already written into the account route about what a lapsed trial should lose.
 *
 * So the table is declarative and complete, and `ENFORCED` is the short list of
 * switches actually thrown. Adding a capability to it is a one-line change, and
 * a visible one.
 */

const TIERS = ['TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'];

/**
 * Capability -> the tiers that include it.
 *
 * Named for what a restaurant does, not for the module that implements it: the
 * frontend and the pricing page both read these names, and `fiscalInvoicing`
 * survives a rewrite of the service behind it in a way that `invoiceService`
 * would not.
 */
const INCLUDED = {
  // The floor. Everything a restaurant needs to take money at a table, on every
  // tier including the trial -- a QR that does not work is not a trial of
  // anything.
  bills: TIERS,
  splitting: TIERS,
  declaredMobilePayment: TIERS,

  c2pCharge: ['STARTER', 'PRO', 'ENTERPRISE'],
  guestOrdering: ['STARTER', 'PRO', 'ENTERPRISE'],

  tipReports: ['PRO', 'ENTERPRISE'],
  menuOcr: ['PRO', 'ENTERPRISE'],
  mfa: ['PRO', 'ENTERPRISE'],

  // The top of the table, and the reason this module exists now. Issuing a
  // fiscal document is the capability whose failure is the restaurant's tax
  // problem rather than a bad evening, so it is the one sold separately.
  fiscalInvoicing: ['ENTERPRISE']
};

/**
 * The capabilities that actually refuse.
 *
 * Read the block comment above before adding to this. Everything here must be
 * something no restaurant can already be relying on, or adding it takes
 * working behaviour away from somebody mid-service.
 */
const ENFORCED = new Set(['fiscalInvoicing']);

/** Every capability name, for the account endpoint and for tests. */
const CAPABILITIES = Object.keys(INCLUDED);

/**
 * Does this tier include this capability?
 *
 * An unknown capability is a programming error and says so rather than
 * returning false: a typo in a route's gate would otherwise read as "nobody may
 * do this", which is a silent outage that looks exactly like a pricing rule.
 */
function tierIncludes(tier, capability) {
  const tiers = INCLUDED[capability];
  if (!tiers) throw new Error(`Unknown capability: ${capability}`);
  return tiers.includes(tier);
}

/**
 * Everything a tier includes, as a flat object.
 *
 * Shaped for the wire: `{ fiscalInvoicing: false, ... }` rather than a list of
 * the true ones, so a client can ask about a capability it does not yet know
 * how to use without having to treat absence as false.
 */
function capabilitiesFor(tier) {
  return Object.fromEntries(CAPABILITIES.map(name => [name, tierIncludes(tier, name)]));
}

/**
 * Whether the API refuses this capability for this tier right now.
 *
 * Not the same question as `tierIncludes`: a capability outside `ENFORCED` is
 * described as excluded and still allowed through, which is the gap the module
 * comment explains.
 */
function isAllowed(tier, capability) {
  if (!ENFORCED.has(capability)) {
    // Still validates the name, so a typo cannot hide behind an un-enforced
    // capability and start refusing nothing at all.
    tierIncludes(tier, capability);
    return true;
  }
  return tierIncludes(tier, capability);
}

/**
 * The tiers that would satisfy this capability, for the refusal message.
 *
 * A client told only "no" has to guess which upgrade fixes it; the answer is
 * already in the table, so it goes in the error.
 */
function tiersOffering(capability) {
  const tiers = INCLUDED[capability];
  if (!tiers) throw new Error(`Unknown capability: ${capability}`);
  return tiers;
}

module.exports = {
  TIERS, CAPABILITIES, INCLUDED, ENFORCED,
  tierIncludes, capabilitiesFor, isAllowed, tiersOffering
};
