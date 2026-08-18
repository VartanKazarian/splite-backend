const { test } = require('node:test');
const assert = require('node:assert/strict');
const dto = require('../src/dto');

/**
 * The persistent-split DTO. The numbers are frozen by the engine and the
 * database; what this owns is the derived "who still owes what" a client would
 * otherwise compute itself -- remaining and settled per share.
 */

const split = (over = {}) => ({
  split: {
    id: 's1', bill_id: 'b1', mode: 'EQUAL', status: 'ACTIVE',
    basis_ves: '20000', created_by_type: 'STAFF',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over.split
  },
  participants: over.participants ?? [
    { id: 'p1', ext_ref: 'a', name: 'Ana', amount_ves: '10000', amount_paid_ves: '10000' },
    { id: 'p2', ext_ref: 'b', name: 'Luis', amount_ves: '10000', amount_paid_ves: '4000' }
  ],
  claims: over.claims ?? [],
  fxRate: over.fxRate ?? null
});

test('a fully-paid share reads as settled with zero remaining', () => {
  const out = dto.billSplit(split());
  const ana = out.participants.find(p => p.ref === 'a');
  assert.equal(ana.remainingVes, '0');
  assert.equal(ana.settled, true);
});

test('a part-paid share reports what is left and is not settled', () => {
  const out = dto.billSplit(split());
  const luis = out.participants.find(p => p.ref === 'b');
  assert.equal(luis.amountPaidVes, '4000');
  assert.equal(luis.remainingVes, '6000');
  assert.equal(luis.settled, false);
});

test('the split echoes its basis and mode, and exposes the share ids to pay against', () => {
  const out = dto.billSplit(split());
  assert.equal(out.basisVes, '20000');
  assert.equal(out.mode, 'EQUAL');
  assert.equal(out.currency, 'VES');
  assert.deepEqual(out.participants.map(p => p.id), ['p1', 'p2']);
});

test('remaining is exact beyond 2^53 centimos', () => {
  const out = dto.billSplit(split({
    split: { basis_ves: '9007199254740993' },
    participants: [{ id: 'p1', ext_ref: 'a', amount_ves: '9007199254740993', amount_paid_ves: '1' }]
  }));
  assert.equal(out.participants[0].remainingVes, '9007199254740992');
});

test('ITEMS claims are surfaced as billItemId/participantId pairs', () => {
  const out = dto.billSplit(split({
    split: { mode: 'ITEMS' },
    claims: [{ bill_item_id: 'i1', participant_id: 'p1' }]
  }));
  assert.deepEqual(out.claims, [{ billItemId: 'i1', participantId: 'p1' }]);
});
