const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  matchInDoubtPayment, OUTCOME, phoneMatchesLast4, amountsEqual, digitsOnly, canonicalReference
} = require('../src/services/c2pMatcher');
const {
  isIndeterminateStatus, toMinorUnits, toBankAmount, redact, mapCharge, MercantilC2PError
} = require('../src/payments/providers/mercantil/c2p');
const { buildInvoiceNumber } = require('../src/services/mercantilC2P');
const { c2pChargeSchema, validate } = require('../src/middleware/schemas');
const { ALLOWED_TRANSITIONS } = require('../src/services/payments');

/**
 * The C2P logic that decides whether money moves, tested where it lives: in
 * pure functions with no database, no bank and no clock. The whole reason the
 * matcher and the amount normaliser are separate modules is that the rule which
 * settles or refuses a charge should be provable without any of that.
 */

// --- Bank amounts -----------------------------------------------------------

test('bank decimal amounts normalise to minor units instead of throwing', () => {
  // The original defect: m.monto ("126.00") fed straight into BigInt threw a
  // SyntaxError, and it did so inside the resolver's .find() — a 500 on the one
  // route that can tell a diner whether their money is gone.
  assert.equal(toMinorUnits('126.00'), '12600');
  assert.equal(toMinorUnits('1.234,56'), '123456');   // es-VE grouping
  assert.equal(toMinorUnits('1234.56'), '123456');    // en grouping
  assert.equal(toMinorUnits('1260000'), '1260000');   // already minor units
  assert.equal(toMinorUnits('12600.5'), '1260050');   // one decimal place
  assert.equal(toMinorUnits('0.05'), '5');
  assert.doesNotThrow(() => toMinorUnits('126.00'));
});

test('an unreadable bank amount is dropped, not guessed', () => {
  for (const bad of ['abc', '', '  ', '1.2.3', '12,34,56', null, undefined, {}]) {
    assert.equal(toMinorUnits(bad), null, `${JSON.stringify(bad)} should be null`);
  }
});

test('toMinorUnits and toBankAmount round-trip', () => {
  // They are the only two places the amount convention is expressed, so a
  // change to one that is not mirrored in the other is caught here rather than
  // as a debit a hundred times too large.
  for (const minor of ['5', '12600', '1260000', '99999999999999']) {
    assert.equal(toMinorUnits(toBankAmount(minor)), minor, `round-trip ${minor}`);
  }
  assert.equal(toBankAmount('12600'), '126.00');
  assert.equal(toBankAmount('5'), '0.05');
  assert.equal(toBankAmount('1260050'), '12600.50');
});

// --- Indeterminate classification -------------------------------------------

test('5xx, 408, 425 and 429 are indeterminate, not rejections', () => {
  // invoice_number is not confirmed idempotent, so an outcome we never learned
  // must never reach the diner as "declined" — they would retry and pay twice.
  for (const code of [408, 425, 429, 500, 502, 503, 504, 599]) {
    assert.ok(isIndeterminateStatus(code), `${code} must be indeterminate`);
  }
  for (const code of [400, 401, 403, 404, 409, 422]) {
    assert.ok(!isIndeterminateStatus(code), `${code} must be a rejection`);
  }
});

test('a charge body with no verdict is indeterminate, not a failure', () => {
  assert.throws(() => mapCharge({ status: 'PENDING' }), MercantilC2PError);
  assert.throws(() => mapCharge({}), MercantilC2PError);
  assert.equal(mapCharge({ status: 'APPROVED', reference: '99' }).status, 'SUCCEEDED');
  assert.equal(mapCharge({ status: 'REJECTED' }).status, 'FAILED');
});

// --- Redaction --------------------------------------------------------------

test('redact removes the single-use clave and other secrets', () => {
  const out = redact({ clave: '123456', amount: '126.00', authorization: 'Bearer x', nested: { password: 'p' } });
  assert.equal(out.clave, '[REDACTED]');
  assert.equal(out.authorization, '[REDACTED]');
  assert.equal(out.nested.password, '[REDACTED]');
  assert.equal(out.amount, '126.00', 'a non-secret field is preserved');
});

// --- The matcher ------------------------------------------------------------

const movement = (over = {}) => ({
  reference: '847291056738', amountMinor: '1260000',
  phoneOrigin: '04145551234', bankOrigin: '0105',
  date: new Date().toISOString(), status: 'COMPLETED', ...over
});
// `charged_ves` rather than `amount_ves`: the matcher compares against what the
// bank was asked to pull, which is the share plus any tip.
const payment = (over = {}) => ({
  amount_ves: '1260000', charged_ves: '1260000',
  payer_bank_code: '0105', payer_phone_last4: '1234', ...over
});

test('amount alone never settles a payment', () => {
  // One movement matching the amount, from a different phone. This is the
  // cross-table settlement the module exists to prevent.
  const r = matchInDoubtPayment([movement({ phoneOrigin: '04149999999' })], payment());
  assert.equal(r.outcome, OUTCOME.AMBIGUOUS);
  assert.ok(!r.movement);
});

test('two tables with identical bills do not cross-settle', () => {
  const r = matchInDoubtPayment([
    movement({ reference: '111111111111', phoneOrigin: '04149999999' }), // another table
    movement({ reference: '222222222222', phoneOrigin: '04145551234' })  // ours
  ], payment());
  assert.equal(r.outcome, OUTCOME.MATCHED);
  assert.equal(r.movement.reference, '222222222222');
  assert.deepEqual(r.signals, ['amount', 'phone_last4']);
});

test('two movements with the same last four digits stay ambiguous', () => {
  const r = matchInDoubtPayment([
    movement({ reference: '111111111111', phoneOrigin: '04141111234' }),
    movement({ reference: '222222222222', phoneOrigin: '04145551234' })
  ], payment());
  assert.equal(r.outcome, OUTCOME.AMBIGUOUS);
  assert.equal(r.candidates.length, 2);
});

test('an already-consumed reference is not a candidate', () => {
  const consumed = new Set([digitsOnly('847291056738')]);
  const r = matchInDoubtPayment([movement()], payment(), consumed);
  assert.equal(r.outcome, OUTCOME.NO_MATCH);
});

test('a movement with an unparseable amount is dropped, not matched', () => {
  const r = matchInDoubtPayment([movement({ amountMinor: null })], payment());
  assert.equal(r.outcome, OUTCOME.NO_MATCH);
});

test('a movement missing its reference is dropped', () => {
  const r = matchInDoubtPayment([movement({ reference: '' })], payment());
  assert.equal(r.outcome, OUTCOME.NO_MATCH);
});

test('a single amount-only candidate is ambiguous, never matched', () => {
  // The tempting case: one movement, right amount, and it is the only thing
  // there. Still not a settlement — the diner at the next table may have paid
  // the same total from a different phone.
  const r = matchInDoubtPayment([movement({ phoneOrigin: '04148887777' })], payment());
  assert.equal(r.outcome, OUTCOME.AMBIGUOUS);
  assert.deepEqual(r.candidates, ['847291056738']);
});

test('a tipped charge matches on what the bank was asked to pull', () => {
  // The bank moved share + tip in one debit, so that is the figure its movement
  // carries. Matching on `amount_ves` found nothing, and NO_MATCH here ends with
  // the charge marked FAILED while the diner stands debited.
  const tipped = payment({ amount_ves: '1260000', charged_ves: '1300000' });

  assert.equal(
    matchInDoubtPayment([movement({ amountMinor: '1300000' })], tipped).outcome,
    OUTCOME.MATCHED
  );
  // And the share on its own is not this payment: some other table paid that.
  assert.equal(
    matchInDoubtPayment([movement({ amountMinor: '1260000' })], tipped).outcome,
    OUTCOME.NO_MATCH
  );
});

test('the matcher refuses to guess which figure it should compare', () => {
  // Defaulting to `amount_ves` would silently match on the wrong number for
  // every tipped charge, which is precisely the bug above. Loud instead.
  assert.throws(
    () => matchInDoubtPayment([movement()], { amount_ves: '1260000', payer_phone_last4: '1234' }),
    /charged_ves/
  );
});

test('one movement has one spelling, whatever endpoint returned it', () => {
  // `provider_payment_id` is what makes "one movement settles one payment"
  // true, through a unique index and through the resolver's spent-movement
  // probe -- both string comparisons. The charge endpoint groups the reference
  // and the search endpoint does not, and until these agreed, one debit could
  // settle two bills.
  const spellings = ['900000000999', '9000 0000 0999', '900-000-000-999', '  900.000.000.999  '];
  const canonical = spellings.map(canonicalReference);
  assert.deepEqual(canonical, Array(spellings.length).fill('900000000999'));
});

test('an identifier that is not a number is never stripped to one', () => {
  // `referenceFor` falls back to providerPaymentId, which is an id rather than
  // a reference. Digits-only would turn this into '429' -- losing the
  // identifier and inviting a collision with somebody's real reference.
  assert.equal(canonicalReference('TX-4F2A-9'), 'TX-4F2A-9');
  assert.equal(canonicalReference('pay_01HZX'), 'pay_01HZX');
});

test('leading zeros are preserved, so padded references stay distinct', () => {
  // Deliberate: merging two references that may genuinely differ is a worse
  // failure than leaving one split, and this matches what the amount and phone
  // comparisons have always assumed.
  assert.equal(canonicalReference('0900000000999'), '0900000000999');
  assert.notEqual(canonicalReference('0900000000999'), canonicalReference('900000000999'));
});

test('a reference that carries no identity at all is null, not empty', () => {
  for (const empty of ['', '   ', '- - -', null, undefined]) {
    assert.equal(canonicalReference(empty), null, JSON.stringify(empty));
  }
});

test('a movement already spent under another spelling is not a candidate', () => {
  // The consumed set is built from what the database holds; the movement comes
  // from the bank. They meet only if both are canonical.
  const consumed = new Set([canonicalReference('9000 0000 0999')]);
  const r = matchInDoubtPayment([movement({ reference: '900000000999' })], payment(), consumed);
  assert.equal(r.outcome, OUTCOME.NO_MATCH);
});

test('phone comparison uses the stored last four digits', () => {
  assert.ok(phoneMatchesLast4('04145551234', '1234'));
  assert.ok(phoneMatchesLast4('+584145551234', '1234'));
  assert.ok(!phoneMatchesLast4('04145559999', '1234'));
  assert.ok(!phoneMatchesLast4('123', '1234'), 'too few digits is not a match');
  assert.ok(!phoneMatchesLast4('04145551234', ''), 'no stored value is not a match');
});

test('amounts compare exactly beyond 2^53', () => {
  assert.ok(amountsEqual('9007199254740993', '9007199254740993'));
  assert.ok(!amountsEqual('9007199254740993', '9007199254740992'));
  assert.ok(!amountsEqual('x', '1'), 'an unparseable side compares false, never throws');
});

// --- The transition table and the trigger must agree ------------------------

test('the service transition table matches the database trigger', () => {
  // ALLOWED_TRANSITIONS is a duplicate of the guard in the migrations, kept for
  // its error message. The duplication is only safe while the two agree, and
  // the first time they did not, every C2P charge failed at the service layer
  // with a 409 for a transition the database would have allowed. This parses
  // the trigger out of migration 019 and compares it.
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '019_c2p_in_doubt_resolution.sql'), 'utf8');

  const fromTrigger = {};
  const re = /OLD\.status = '(\w+)'\s*AND NEW\.status IN \(([^)]+)\)/g;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const to = m[2].match(/'(\w+)'/g).map(s => s.replace(/'/g, ''));
    fromTrigger[m[1]] = (fromTrigger[m[1]] || []).concat(to);
  }

  // Every move the trigger allows must be allowed by the service, or a legal
  // transition surfaces as a 500 instead of happening.
  for (const [from, tos] of Object.entries(fromTrigger)) {
    for (const to of tos) {
      assert.ok(
        (ALLOWED_TRANSITIONS[from] || []).includes(to),
        `trigger allows ${from} -> ${to} but the service does not`
      );
    }
  }

  // And the reverse, ignoring same-status (the trigger returns early on it):
  // a move the service permits that the trigger forbids is a 500 waiting to
  // happen the first time it is exercised.
  for (const [from, tos] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const to of tos) {
      if (from === to) continue;
      assert.ok(
        (fromTrigger[from] || []).includes(to),
        `service allows ${from} -> ${to} but the trigger forbids it`
      );
    }
  }
});


// --- The invoice-number policy ---------------------------------------------

test('the invoice number follows SPL-<REST8>-<PAY32>', () => {
  const inv = buildInvoiceNumber({
    restaurantId: 'a1b2c3d4-e5f6-4a1b-8c2d-001122334455',
    paymentId: 'ffeeddcc-bbaa-4998-8776-655443322110'
  });
  assert.match(inv, /^SPL-[0-9A-F]{8}-[0-9A-F]{32}$/);
  assert.equal(inv, 'SPL-A1B2C3D4-FFEEDDCCBBAA49988776655443322110');
});

test('the invoice embeds the restaurant and the full payment id, without truncating', () => {
  const paymentId = 'ffeeddcc-bbaa-4998-8776-655443322110';
  const inv = buildInvoiceNumber({ restaurantId: 'a1b2c3d4-e5f6-4a1b-8c2d-001122334455', paymentId });
  // The whole 32 hex of the payment is present -- the old form kept only 24, so
  // two payments sharing a 24-hex prefix would have collided.
  assert.ok(inv.endsWith(paymentId.replace(/-/g, '').toUpperCase()));
  assert.ok(inv.includes('A1B2C3D4'), 'the restaurant short is present for auditability');
});

test('the invoice is deterministic and unique per payment', () => {
  const r = 'a1b2c3d4-e5f6-4a1b-8c2d-001122334455';
  const p1 = '11111111-1111-4111-8111-111111111111';
  const p2 = '22222222-2222-4222-8222-222222222222';
  assert.equal(buildInvoiceNumber({ restaurantId: r, paymentId: p1 }),
    buildInvoiceNumber({ restaurantId: r, paymentId: p1 }), 'same payment -> same invoice');
  assert.notEqual(buildInvoiceNumber({ restaurantId: r, paymentId: p1 }),
    buildInvoiceNumber({ restaurantId: r, paymentId: p2 }), 'different payments -> different invoices');
});

test('a client-supplied invoiceNumber never reaches the charge', () => {
  // The policy: the invoice is server-owned. The schema does not define it, and
  // validation strips unknown keys, so a value the frontend sends is discarded
  // before any handler sees it -- it can never become the invoice on a charge.
  const req = {
    body: {
      amountVes: '126000', bankCode: '0105', idNumber: 'V12345678',
      phone: '04145551234', clave: '123456', idempotencyKey: 'abcdefghijklmnop',
      invoiceNumber: 'SPL-DEADBEEF-00000000000000000000000000000000',
      invoice_number: '12345'
    }
  };
  let cleaned;
  validate(c2pChargeSchema, 'body')(req, {}, () => { cleaned = req.body; });
  assert.ok(cleaned, 'the request validated');
  assert.equal(cleaned.invoiceNumber, undefined, 'a supplied invoiceNumber is stripped');
  assert.equal(cleaned.invoice_number, undefined, 'a supplied invoice_number is stripped');
});
