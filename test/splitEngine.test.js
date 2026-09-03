const { test } = require('node:test');
const assert = require('node:assert/strict');

const { preview } = require('../src/services/splitEngine');

/**
 * The split engine, in isolation.
 *
 * Every case here asserts the same thing in the end: the parts sum to exactly
 * what was outstanding. That is the property the whole file exists to hold, and
 * it is the one that is silent when broken -- a bill simply never closes, or a
 * diner is a céntimo short and cannot pay.
 */

const bill = (overrides = {}) => ({
  id: 'bill-1',
  total_due_ves: '10000',
  amount_paid_ves: '0',
  fx_rate_ves_per_unit: '757.54060000',
  ...overrides
});

const people = (...ids) => ids.map(id => ({ id }));

/** Sums allocations with BigInt, which is the only way the assertion is honest. */
const sum = result => result.allocations.reduce((total, a) => total + BigInt(a.amountVes), 0n);

const assertExact = result => {
  assert.equal(sum(result).toString(), result.outstandingVes, 'allocations must sum to the outstanding balance');
  assert.equal(result.totalAllocatedVes, result.outstandingVes, 'the reported total must agree');
  return result;
};

test('FULL gives one participant the whole outstanding balance', () => {
  const result = assertExact(preview({
    bill: bill(), request: { mode: 'FULL', participants: people('p1') }
  }));
  assert.equal(result.allocations[0].amountVes, '10000');
});

test('FULL insists on exactly one participant', () => {
  for (const ids of [['p1', 'p2'], ['p1', 'p2', 'p3']]) {
    assert.throws(
      () => preview({ bill: bill(), request: { mode: 'FULL', participants: people(...ids) } }),
      err => {
        assert.equal(err.code, 'SPLIT_PARTICIPANTS_INVALID');
        return true;
      }
    );
  }
});

test('EQUAL divides evenly and hands the remainder out one céntimo at a time', () => {
  // 10000 across 3 is 3333.33; the parts must be 3334/3333/3333, not 3333 x 3.
  const result = assertExact(preview({
    bill: bill(), request: { mode: 'EQUAL', participants: people('p1', 'p2', 'p3') }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['3334', '3333', '3333']);
});

test('EQUAL stays exact for every party size up to 50', () => {
  // The property, not an example: no size may lose or invent a céntimo.
  for (let n = 1; n <= 50; n++) {
    const participants = Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));
    const result = assertExact(preview({
      bill: bill({ total_due_ves: '100003' }), request: { mode: 'EQUAL', participants }
    }));
    assert.equal(result.allocations.length, n);
  }
});

test('EQUAL splits an amount beyond 2^53 without losing a céntimo', () => {
  // Number arithmetic silently rounds here; the allocation is BigInt throughout.
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '9007199254740993' }),
    request: { mode: 'EQUAL', participants: people('p1', 'p2', 'p3') }
  }));
  assert.equal(sum(result).toString(), '9007199254740993');
});

test('the basis is what is outstanding, not the original total', () => {
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '10000', amount_paid_ves: '4000' }),
    request: { mode: 'EQUAL', participants: people('p1', 'p2') }
  }));
  assert.equal(result.outstandingVes, '6000');
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['3000', '3000']);
});

test('a settled bill has nothing to split', () => {
  assert.throws(
    () => preview({
      bill: bill({ total_due_ves: '10000', amount_paid_ves: '10000' }),
      request: { mode: 'EQUAL', participants: people('p1', 'p2') }
    }),
    err => {
      assert.equal(err.code, 'SPLIT_NOTHING_OUTSTANDING');
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
});

test('duplicate participant ids are refused before any arithmetic', () => {
  assert.throws(
    () => preview({ bill: bill(), request: { mode: 'EQUAL', participants: people('p1', 'p1') } }),
    err => {
      assert.equal(err.code, 'SPLIT_PARTICIPANTS_INVALID');
      assert.match(err.details.reason, /unique/i);
      return true;
    }
  );
});

/* ---------- ITEMS ---------- */

const items = [
  { id: 'i1', subtotal_minor: '2500' },
  { id: 'i2', subtotal_minor: '1500' },
  { id: 'i3', subtotal_minor: '1000' }
];

test('ITEMS gives each participant the lines they claimed', () => {
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '5000' }),
    items,
    request: {
      mode: 'ITEMS',
      participants: people('ana', 'bea'),
      claims: [
        { itemId: 'i1', participantIds: ['ana'] },
        { itemId: 'i2', participantIds: ['bea'] },
        { itemId: 'i3', participantIds: ['bea'] }
      ]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['2500', '2500']);
});

test('ITEMS splits a shared line evenly between its claimants', () => {
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '5000' }),
    items,
    request: {
      mode: 'ITEMS',
      participants: people('ana', 'bea'),
      claims: [
        { itemId: 'i1', participantIds: ['ana', 'bea'] }, // 2500 shared -> 1250 each
        { itemId: 'i2', participantIds: ['ana'] },        // 1500
        { itemId: 'i3', participantIds: ['bea'] }         // 1000
      ]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['2750', '2250']);
});

test('ITEMS stays exact when a shared line does not divide cleanly', () => {
  // 1001 across three claimants: the two-stage allocation must still total 1001.
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '1001' }),
    items: [{ id: 'only', subtotal_minor: '1001' }],
    request: {
      mode: 'ITEMS',
      participants: people('a', 'b', 'c'),
      claims: [{ itemId: 'only', participantIds: ['a', 'b', 'c'] }]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['334', '334', '333']);
});

test('ITEMS refuses to leave a line unclaimed', () => {
  assert.throws(
    () => preview({
      bill: bill({ total_due_ves: '5000' }),
      items,
      request: {
        mode: 'ITEMS',
        participants: people('ana'),
        claims: [{ itemId: 'i1', participantIds: ['ana'] }]
      }
    }),
    err => {
      // An unclaimed line is money owed by nobody, so the parts could not sum.
      assert.equal(err.code, 'SPLIT_CLAIMS_INCOMPLETE');
      assert.deepEqual(err.details.unclaimedItemIds, ['i2', 'i3']);
      return true;
    }
  );
});

test('ITEMS refuses claims naming a line or a person it does not know', () => {
  assert.throws(
    () => preview({
      bill: bill({ total_due_ves: '5000' }),
      items,
      request: {
        mode: 'ITEMS',
        participants: people('ana'),
        claims: [
          { itemId: 'i1', participantIds: ['ana'] },
          { itemId: 'i2', participantIds: ['ana'] },
          { itemId: 'i3', participantIds: ['ana'] },
          { itemId: 'not-a-line', participantIds: ['ghost'] }
        ]
      }
    }),
    err => {
      assert.equal(err.code, 'SPLIT_CLAIM_UNKNOWN');
      assert.deepEqual(err.details.unknownItemIds, ['not-a-line']);
      assert.deepEqual(err.details.unknownParticipantIds, ['ghost']);
      return true;
    }
  );
});

test('ITEMS on a bill with no lines says so', () => {
  assert.throws(
    () => preview({
      bill: bill(), items: [],
      request: { mode: 'ITEMS', participants: people('ana'), claims: [] }
    }),
    err => {
      assert.equal(err.code, 'SPLIT_NOT_ITEMISED');
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
});

test('ITEMS handles a free line without dividing by zero', () => {
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '2500' }),
    items: [{ id: 'paid', subtotal_minor: '2500' }, { id: 'free', subtotal_minor: '0' }],
    request: {
      mode: 'ITEMS',
      participants: people('ana', 'bea'),
      claims: [
        { itemId: 'paid', participantIds: ['ana'] },
        { itemId: 'free', participantIds: ['bea'] }
      ]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['2500', '0']);
});

/* ---------- CUSTOM ---------- */

test('CUSTOM accepts amounts that add up exactly', () => {
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '10000' }),
    request: {
      mode: 'CUSTOM',
      participants: [
        { id: 'p1', amountVes: '6000' },
        { id: 'p2', amountVes: '3000' },
        { id: 'p3', amountVes: '1000' }
      ]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['6000', '3000', '1000']);
});

test('CUSTOM refuses amounts that do not add up, rather than adjusting them', () => {
  for (const [label, amounts] of [['short', ['4000', '5000']], ['over', ['6000', '5000']]]) {
    assert.throws(
      () => preview({
        bill: bill({ total_due_ves: '10000' }),
        request: {
          mode: 'CUSTOM',
          participants: amounts.map((amountVes, i) => ({ id: `p${i}`, amountVes }))
        }
      }),
      err => {
        // Silently rounding into shape would hide a client bug behind a number
        // that looks right.
        assert.equal(err.code, 'SPLIT_AMOUNT_MISMATCH', label);
        assert.equal(err.details.outstandingVes, '10000');
        return true;
      }
    );
  }
});

test('CUSTOM lets a participant owe nothing', () => {
  const result = assertExact(preview({
    bill: bill({ total_due_ves: '10000' }),
    request: {
      mode: 'CUSTOM',
      participants: [{ id: 'p1', amountVes: '10000' }, { id: 'p2', amountVes: '0' }]
    }
  }));
  assert.equal(result.allocations[1].amountVes, '0');
});

test('every mode reports the same basis and a matching total', () => {
  const shared = { bill: bill({ total_due_ves: '9999' }), items: [{ id: 'i1', subtotal_minor: '9999' }] };
  const requests = [
    { mode: 'FULL', participants: people('p1') },
    { mode: 'EQUAL', participants: people('p1', 'p2', 'p3') },
    { mode: 'ITEMS', participants: people('p1', 'p2'), claims: [{ itemId: 'i1', participantIds: ['p1', 'p2'] }] },
    { mode: 'CUSTOM', participants: [{ id: 'p1', amountVes: '9999' }] }
  ];

  for (const request of requests) {
    const result = assertExact(preview({ ...shared, request }));
    assert.equal(result.outstandingVes, '9999', `${request.mode} divided the wrong figure`);
    assert.equal(result.currency, 'VES');
  }
});

test('a USD reference rides along without ever being the settlement figure', () => {
  const result = preview({
    bill: bill({ total_due_ves: '757541' }),
    request: { mode: 'EQUAL', participants: people('p1') }
  });
  assert.equal(result.allocations[0].amountVes, '757541');
  assert.equal(result.allocations[0].usdReference, '10.00');
  assert.equal(result.currency, 'VES', 'settlement is VES no matter what the reference says');
});

test('no rate means no reference, not a wrong one', () => {
  const result = preview({
    bill: bill({ fx_rate_ves_per_unit: null }),
    request: { mode: 'EQUAL', participants: people('p1') }
  });
  assert.equal(result.allocations[0].usdReference, null);
});

/**
 * Dividing one line by units.
 *
 * The bug this closes: claims were keyed into a Map by itemId, so two claims on
 * the same line kept only the last one and the first claimant was handed
 * nothing. A diner picking one of three empanadas saw zero and the other party
 * saw the whole line -- money vanishing with no error at all.
 *
 * The guest screen had been sending per-unit claims the whole time; `quantity`
 * was stripped by validation before the engine could see it, so the request
 * quietly meant something else than what was on screen.
 */
test('ITEMS divides one line between claimants by units', () => {
  const result = assertExact(preview({
    bill: { total_due_ves: '3750000', amount_paid_ves: '0', currency: 'VES', fx_rate_ves_per_unit: '1' },
    items: [{ id: 'i1', subtotal_minor: '3750000', quantity: 3, name_snapshot: 'Pabellón' }],
    request: {
      mode: 'ITEMS',
      participants: [{ id: 'me' }, { id: 'others' }],
      claims: [
        { itemId: 'i1', quantity: 1, participantIds: ['me'] },
        { itemId: 'i1', quantity: 2, participantIds: ['others'] }
      ]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['1250000', '2500000']);
});

test('a claim without a quantity still means the whole line', () => {
  // The shape before quantities existed. A client that never sends the field
  // has to keep meaning exactly what it meant.
  const result = assertExact(preview({
    bill: { total_due_ves: '3000', amount_paid_ves: '0', currency: 'VES', fx_rate_ves_per_unit: '1' },
    items: [{ id: 'i1', subtotal_minor: '3000', quantity: 3, name_snapshot: 'x' }],
    request: {
      mode: 'ITEMS',
      participants: [{ id: 'ana' }, { id: 'bea' }],
      claims: [{ itemId: 'i1', participantIds: ['ana'] }]
    }
  }));
  assert.deepEqual(result.allocations.map(a => a.amountVes), ['3000', '0']);
});

test('units that do not add up to the line are refused', () => {
  // Claiming two of three leaves one owed by nobody, and the allocation would
  // not sum to the bill. Refused rather than quietly rounded into shape.
  assert.throws(
    () => preview({
      bill: { total_due_ves: '3000', amount_paid_ves: '0', currency: 'VES', fx_rate_ves_per_unit: '1' },
      items: [{ id: 'i1', subtotal_minor: '3000', quantity: 3, name_snapshot: 'x' }],
      request: {
        mode: 'ITEMS',
        participants: [{ id: 'me' }, { id: 'others' }],
        claims: [{ itemId: 'i1', quantity: 2, participantIds: ['me'] }]
      }
    }),
    err => err.code === 'SPLIT_CLAIMS_INCOMPLETE'
  );
});

test('units split between claimants stay exact on an odd line', () => {
  // 1000 over 3 units is 333.33 each: the two-stage largest-remainder has to
  // place every céntimo or the split stops summing to the bill.
  const result = assertExact(preview({
    bill: { total_due_ves: '1000', amount_paid_ves: '0', currency: 'VES', fx_rate_ves_per_unit: '1' },
    items: [{ id: 'i1', subtotal_minor: '1000', quantity: 3, name_snapshot: 'x' }],
    request: {
      mode: 'ITEMS',
      participants: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      claims: [
        { itemId: 'i1', quantity: 1, participantIds: ['a'] },
        { itemId: 'i1', quantity: 1, participantIds: ['b'] },
        { itemId: 'i1', quantity: 1, participantIds: ['c'] }
      ]
    }
  }));
  const total = result.allocations.reduce((s, a) => s + BigInt(a.amountVes), 0n);
  assert.equal(total, 1000n, 'every céntimo has to land somewhere');
});
