const { ApiError } = require('../errors');
const { allocate, usdReference } = require('./split');
const { toMinor } = require('./money');

/**
 * Computes who owes what, exactly.
 *
 * This is advisory: it reads a bill and returns an allocation, and mutates
 * nothing. Payment still goes through the payments endpoint, which holds the
 * row lock and enforces the overpayment ceiling.
 *
 * Two decisions shape everything here.
 *
 * **One basis for every mode.** All four divide the *outstanding VES balance* —
 * what is left to settle — rather than each picking whichever figure suits it.
 * A client that had to ask "which number did this divide?" per mode would be
 * doing arithmetic of its own, which is the thing this endpoint exists to stop.
 * The basis is echoed back as `outstandingVes` so it is never in doubt.
 *
 * **Exactness is structural, not checked afterwards.** Every mode routes
 * through `allocate`, a largest-remainder split whose parts sum to the total by
 * construction. Rounding each share independently would leave the last diner
 * unable to pay under `CHECK (amount_paid_ves <= total_due_ves)`, or leave the
 * bill a few céntimos short of closing forever.
 */

const MODES = ['FULL', 'EQUAL', 'ITEMS', 'CUSTOM'];

function invalidParticipants(reason) {
  return new ApiError('SPLIT_PARTICIPANTS_INVALID', reason, { reason });
}

/**
 * Allocates `total` across `weights`, tolerating zero weights.
 *
 * `allocate` requires every weight to be positive, which is right for its own
 * purposes but wrong here: a participant who claims nothing owes nothing, and
 * that is an answer rather than an error. Zero-weight entries are held out of
 * the division and handed back a zero.
 */
function allocateWithZeros(total, weights) {
  const result = new Array(weights.length).fill('0');
  const contributing = [];
  weights.forEach((weight, index) => {
    if (weight > 0n) contributing.push(index);
  });

  if (contributing.length === 0) {
    // Nobody has a claim on anything. Only reachable when every weight is zero,
    // which means there is nothing to divide either.
    if (total > 0n) {
      throw invalidParticipants('No participant has a share of this bill');
    }
    return result;
  }

  const parts = allocate(total, contributing.map(i => weights[i]));
  contributing.forEach((index, i) => { result[index] = parts[i]; });
  return result;
}

/** Rejects duplicate or missing participant ids before any arithmetic runs. */
function normaliseParticipants(participants) {
  const ids = participants.map(p => p.id);
  if (new Set(ids).size !== ids.length) {
    throw invalidParticipants('Participant ids must be unique');
  }
  return participants;
}

/**
 * ITEMS: participants claim lines, and a line may be shared.
 *
 * Allocated in two stages, both largest-remainder, so the total is exact at
 * each step and therefore exact overall:
 *
 *   1. the outstanding balance across the lines, by line subtotal
 *   2. each line's resulting VES across the participants claiming it
 *
 * Summing per participant then cannot drift, because every céntimo was placed
 * by one of the two divisions.
 */
function allocateByItems({ outstanding, items, participants, claims }) {
  if (items.length === 0) {
    throw new ApiError('SPLIT_NOT_ITEMISED', 'This bill has no line items to split by');
  }

  const participantIds = new Set(participants.map(p => p.id));
  const itemIds = new Set(items.map(i => i.id));

  const unknownItemIds = [...new Set(claims.map(c => c.itemId).filter(id => !itemIds.has(id)))];
  const unknownParticipantIds = [...new Set(
    claims.flatMap(c => c.participantIds).filter(id => !participantIds.has(id))
  )];
  if (unknownItemIds.length || unknownParticipantIds.length) {
    throw new ApiError(
      'SPLIT_CLAIM_UNKNOWN',
      'A claim refers to a line or a participant that is not part of this split',
      { unknownItemIds, unknownParticipantIds }
    );
  }

  // Every line must be claimed. An unclaimed line would leave part of the bill
  // owed by nobody, and the allocation would not sum to the outstanding total.
  const claimedItemIds = new Set(claims.filter(c => c.participantIds.length > 0).map(c => c.itemId));
  const unclaimedItemIds = items.map(i => i.id).filter(id => !claimedItemIds.has(id));
  if (unclaimedItemIds.length) {
    throw new ApiError(
      'SPLIT_CLAIMS_INCOMPLETE',
      'Every line has to be claimed by someone before the bill can be split by item',
      { unclaimedItemIds }
    );
  }

  // Stage 1: the outstanding balance across the lines, weighted by subtotal. A
  // free line carries a zero weight and simply receives nothing.
  const perItemVes = allocateWithZeros(
    outstanding,
    items.map(item => toMinor(item.subtotal_minor))
  );

  // Stage 2: each line's share across whoever claimed it.
  //
  // Grouped, not keyed. This used to be
  //   new Map(claims.map(c => [c.itemId, c.participantIds]))
  // which silently keeps only the *last* claim for a line: two people splitting
  // one line by units -- me one of three, you the other two -- collapsed to one
  // entry and the first claimant was handed nothing. It was money disappearing
  // without an error, which is the worst way for this to be wrong.
  const owed = new Map(participants.map(p => [p.id, 0n]));
  const claimsByItem = new Map(items.map(i => [i.id, []]));
  for (const claim of claims) {
    if (claim.participantIds.length > 0) claimsByItem.get(claim.itemId).push(claim);
  }

  items.forEach((item, index) => {
    const itemClaims = claimsByItem.get(item.id) ?? [];
    const itemVes = toMinor(perItemVes[index]);
    const units = BigInt(item.quantity ?? 1);

    // A claim without a quantity is a claim on the whole line, which is what
    // the shape meant before quantities existed: one claim, everyone on it
    // sharing the line evenly. Existing clients keep their meaning.
    const claimed = itemClaims.map(c => (c.quantity === undefined ? units : BigInt(c.quantity)));
    const totalClaimed = claimed.reduce((a, b) => a + b, 0n);

    // The parts have to be the whole. Claiming two of three units leaves one
    // owed by nobody, and the allocation would not sum to the bill.
    if (itemClaims.length > 0 && totalClaimed !== units) {
      throw new ApiError(
        'SPLIT_CLAIMS_INCOMPLETE',
        'The units claimed on a line have to add up to the units on it',
        { itemId: item.id, unitsOnLine: Number(units), unitsClaimed: Number(totalClaimed) }
      );
    }

    // The line's money across the claims, by units; then each claim's money
    // across the people on it, evenly. Both largest-remainder, so the line is
    // exact at each step and therefore exact overall.
    const perClaim = allocateWithZeros(itemVes, claimed);
    itemClaims.forEach((claim, ci) => {
      const claimVes = toMinor(perClaim[ci]);
      // Split evenly between the people on one claim: a shared bottle is
      // halved, not weighted by anything the client could assert about who
      // drank more.
      const shares = allocateWithZeros(claimVes, claim.participantIds.map(() => 1n));
      claim.participantIds.forEach((participantId, i) => {
        owed.set(participantId, owed.get(participantId) + toMinor(shares[i]));
      });
    });
  });

  return participants.map(p => owed.get(p.id).toString());
}

/** CUSTOM: the client states the amounts, and they must be exact. */
function allocateCustom({ outstanding, participants }) {
  const amounts = participants.map(p => {
    const amount = toMinor(p.amountVes ?? '0', 'Participant amount');
    if (amount < 0n) throw invalidParticipants('An amount cannot be negative');
    return amount;
  });

  const submitted = amounts.reduce((a, b) => a + b, 0n);
  if (submitted !== outstanding) {
    // Deliberately not rounded into shape. A custom split that does not add up
    // is a mistake in the client, and silently adjusting it would hide it.
    throw new ApiError(
      'SPLIT_AMOUNT_MISMATCH',
      'The amounts have to add up to exactly what is outstanding',
      { outstandingVes: outstanding.toString(), submittedTotalVes: submitted.toString() }
    );
  }
  return amounts.map(String);
}

/**
 * Returns the allocation for a bill, or throws explaining why there is none.
 *
 * `bill` and `items` are rows; `request` is the validated body.
 */
function preview({ bill, items = [], request }) {
  if (!MODES.includes(request.mode)) {
    throw invalidParticipants(`Unknown split mode: ${request.mode}`);
  }

  const participants = normaliseParticipants(request.participants);
  const outstanding = toMinor(bill.total_due_ves) - toMinor(bill.amount_paid_ves);

  if (outstanding <= 0n) {
    throw new ApiError(
      'SPLIT_NOTHING_OUTSTANDING',
      'This bill is already settled, so there is nothing to split'
    );
  }
  if (request.mode === 'FULL' && participants.length !== 1) {
    throw invalidParticipants('A FULL split names exactly one participant');
  }

  let amounts;
  switch (request.mode) {
    case 'FULL':
      amounts = [outstanding.toString()];
      break;
    case 'EQUAL':
      amounts = allocate(outstanding, participants.map(() => 1n));
      break;
    case 'ITEMS':
      amounts = allocateByItems({ outstanding, items, participants, claims: request.claims ?? [] });
      break;
    case 'CUSTOM':
      amounts = allocateCustom({ outstanding, participants });
      break;
  }

  const rate = bill.fx_rate_ves_per_unit ?? null;
  const allocations = participants.map((participant, index) => ({
    participantId: participant.id,
    name: participant.name ?? null,
    amountVes: amounts[index],
    usdReference: usdReference(amounts[index], rate)
  }));

  const totalAllocated = amounts.reduce((sum, amount) => sum + toMinor(amount), 0n);

  // The invariant this whole file exists for. It holds by construction, so if
  // it ever fails a mode has stopped going through `allocate` -- which is worth
  // a 500 rather than a quietly wrong bill.
  if (totalAllocated !== outstanding) {
    throw new Error(
      `Split allocation does not sum to the outstanding balance: ${totalAllocated} vs ${outstanding}`
    );
  }

  return {
    billId: bill.id,
    mode: request.mode,
    currency: 'VES',
    outstandingVes: outstanding.toString(),
    totalAllocatedVes: totalAllocated.toString(),
    allocations
  };
}

module.exports = { preview, MODES };
