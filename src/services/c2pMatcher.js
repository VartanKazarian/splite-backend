/**
 * Matching a bank movement to an in-doubt C2P charge.
 *
 * When Mercantil stops answering mid-charge we are left holding a payment we
 * cannot classify, and the only way to find out what happened is to ask the
 * bank for its movements and look for ours. The obvious implementation is one
 * line:
 *
 *   movements.find(m => BigInt(m.amountMinor) === BigInt(payment.amount_ves))
 *
 * In a restaurant, two tables owing the same total is the ordinary case, not an
 * edge case -- set menus, two of the same dish, a bill split four ways. That
 * `find()` settles table 3 with table 7's money and leaves table 7 still owing,
 * and both errors are discovered by a person arguing at the till.
 *
 * The rule here is therefore: AMOUNT IS A FILTER, NEVER A DECISION. A movement
 * settles a payment only when something ties it to *that* diner. When two
 * candidates are equally plausible the answer is AMBIGUOUS and a person
 * decides, because closing the wrong bill is worse than closing none.
 *
 * Pure and synchronous on purpose. Everything this needs is already in memory
 * by the time it is called, so the rule that decides whether money moves is
 * testable without a database, a bank, or a clock.
 */

const OUTCOME = Object.freeze({
  MATCHED: 'MATCHED',
  AMBIGUOUS: 'AMBIGUOUS',
  NO_MATCH: 'NO_MATCH'
});

/**
 * Digits only. Bank references arrive spaced, dashed and zero-padded depending
 * on which endpoint returned them, and two spellings of one reference must not
 * look like two movements.
 */
const digitsOnly = value => String(value ?? '').replace(/\D/g, '');

/**
 * Compare phones by their last four digits, which is all we store.
 *
 * A movement carries the payer's full number and we keep four digits of it, so
 * the comparison happens at the precision of the weaker side. Anything shorter
 * than four digits on either side is not a comparison at all and is refused
 * rather than being padded into a false match -- `'123'` must not match
 * `'0123'`.
 */
function phoneMatchesLast4(movementPhone, storedLast4) {
  const movement = digitsOnly(movementPhone);
  const stored = digitsOnly(storedLast4);
  if (movement.length < 4 || stored.length !== 4) return false;
  return movement.slice(-4) === stored;
}

/**
 * Exact comparison of two minor-unit amounts.
 *
 * BigInt rather than Number because a bill can exceed 2^53 céntimos, and
 * try/catch rather than a regex because the values reaching here have already
 * been through `toMinorUnits`; anything it could not normalise arrives as null
 * and must compare false instead of throwing. Throwing here is precisely the
 * bug this pair of functions was written to fix -- it happened inside a
 * `.find()`, so it surfaced as a 500 on the one route that can tell a diner
 * whether their money is gone.
 */
function amountsEqual(a, b) {
  try {
    return BigInt(String(a)) === BigInt(String(b));
  } catch {
    return false;
  }
}

/**
 * Decide whether any of the bank's movements is this payment.
 *
 * @param {Array<object>} movements  as returned by MercantilC2PClient.search()
 * @param {object} payment           { amount_ves, payer_phone_last4 }
 * @param {Set<string>} consumedReferences  normalised references that have
 *        already settled something. Passing them in rather than filtering
 *        afterwards keeps a spent movement out of the *candidate* count, so a
 *        reference already used elsewhere cannot make an otherwise clear match
 *        look ambiguous.
 * @returns {{outcome: string, movement?: object, signals?: string[],
 *            candidates?: string[], reason?: string}}
 */
function matchInDoubtPayment(movements, payment, consumedReferences = new Set()) {
  const expected = payment.amount_ves;

  const candidates = (movements ?? []).filter(movement => {
    // amountMinor is null when the bank sent a shape `toMinorUnits` could not
    // read. Dropped rather than guessed at: a movement we cannot price is not
    // evidence of anything.
    if (!movement?.reference || movement.amountMinor == null) return false;
    if (consumedReferences.has(digitsOnly(movement.reference))) return false;
    return amountsEqual(movement.amountMinor, expected);
  });

  if (!candidates.length) {
    return { outcome: OUTCOME.NO_MATCH, candidates: [], reason: 'No movement matches the amount' };
  }

  const byPhone = candidates.filter(movement =>
    phoneMatchesLast4(movement.phoneOrigin, payment.payer_phone_last4));

  if (byPhone.length === 1) {
    return { outcome: OUTCOME.MATCHED, movement: byPhone[0], signals: ['amount', 'phone_last4'] };
  }

  if (byPhone.length > 1) {
    // Same amount, same last four digits, different references. Rare, and the
    // one case where guessing is most tempting and least defensible: these are
    // two payments that look identical in every field we hold.
    return {
      outcome: OUTCOME.AMBIGUOUS,
      candidates: byPhone.map(m => String(m.reference)),
      reason: 'Several movements match on both amount and payer phone'
    };
  }

  // Nothing matched the phone. Note that a *single* amount-only candidate is
  // still ambiguous: the diner at the next table may have paid an identical
  // total from a different phone, and settling on that basis is the exact
  // cross-table error this module exists to prevent.
  return {
    outcome: OUTCOME.AMBIGUOUS,
    candidates: candidates.map(m => String(m.reference)),
    reason: candidates.length === 1
      ? 'The amount matches but the payer phone does not'
      : 'Several movements share the amount and none identifies the payer'
  };
}

module.exports = { matchInDoubtPayment, OUTCOME, phoneMatchesLast4, amountsEqual, digitsOnly };
