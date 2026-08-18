const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  matchInDoubtPayment, OUTCOME, phoneMatchesLast4, amountsEqual, digitsOnly
} = require('../src/services/c2pMatcher');
const {
  isIndeterminateStatus, toMinorUnits, toBankAmount, redact, mapCharge, MercantilC2PError
} = require('../src/payments/providers/mercantil/c2p');
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
const payment = (over = {}) => ({
  amount_ves: '1260000', payer_bank_code: '0105', payer_phone_last4: '1234', ...over
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
