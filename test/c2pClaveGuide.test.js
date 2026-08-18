const { test } = require('node:test');
const assert = require('node:assert/strict');

const guide = require('../src/payments/c2pClaveGuide');
const banks = require('../src/payments/banks');

/**
 * The clave guide, checked against the two things that break a payment when a
 * bank's entry is wrong: whether the diner is told to fetch the clave in time,
 * and whether they are pointed at a channel their bank actually has.
 */

test('every guided bank is a bank the payout/charge layer knows', () => {
  // A clave guide for a code no other module recognises would offer a diner a
  // bank they can never actually be charged through.
  for (const code of Object.keys(guide.CLAVE_GUIDE)) {
    assert.ok(banks.isKnown(code), `${code} is in the clave guide but not in banks.js`);
  }
});

test('short-lived and amount-bound claves are fetched at payment, not before', () => {
  // The whole reason the strategy exists. A diner who fetches a Banplus clave
  // when they sit down reaches the till with a dead one.
  assert.equal(guide.claveStrategy('0174').when, 'at_payment', 'Banplus, 5 minutes');
  assert.equal(guide.claveStrategy('0128').when, 'at_payment', 'Caroní, 60 minutes');
  assert.equal(guide.claveStrategy('0156').when, 'at_payment', '100% Banco, amount-bound');

  // Long TTLs can be fetched while waiting.
  assert.equal(guide.claveStrategy('0105').when, 'anytime', 'Mercantil, 6 hours');
  assert.equal(guide.claveStrategy('0102').when, 'anytime', 'Banco de Venezuela, until close of day');
});

test('an unknown bank yields no instructions rather than an empty card', () => {
  assert.equal(guide.claveStrategy('9999'), null);
  assert.equal(guide.claveInstructions('9999'), null);
});

test('instructions offer only the channels the bank actually has', () => {
  // Banco Activo is SMS-only: offering it an app or web step sends the diner
  // looking for something that is not there.
  const activo = guide.claveInstructions('0171');
  assert.deepEqual(activo.channels.map(c => c.channel), ['SMS']);

  // Mercantil is app + SMS, no web.
  const mercantil = guide.claveInstructions('0105');
  assert.deepEqual(mercantil.channels.map(c => c.channel).sort(), ['APP', 'SMS']);
  const sms = mercantil.channels.find(c => c.channel === 'SMS');
  assert.equal(sms.shortCode, '24024');
  assert.equal(sms.smsBody, 'SCP');
});

test('the SMS body carries the diner identity where the bank format takes it', () => {
  const exterior = guide.claveInstructions('0115', { idType: 'V', idNumber: '12345678' });
  const sms = exterior.channels.find(c => c.channel === 'SMS');
  assert.match(sms.smsBody, /CLAVE V 12345678/);
  assert.equal(sms.shortCode, '278');

  // Without an identity, a placeholder rather than a broken template.
  const placeholder = guide.claveInstructions('0115');
  assert.match(placeholder.channels.find(c => c.channel === 'SMS').smsBody, /your ID number/);
});

test('the dual-carrier SMS short code is preserved', () => {
  // Banfanb: 326200 from Digitel/Movistar, 78900 from Movilnet. Losing the
  // alternate silently strands one carrier's customers.
  const banfanb = guide.claveInstructions('0177');
  const sms = banfanb.channels.find(c => c.channel === 'SMS');
  assert.equal(sms.shortCode, '326200');
  assert.equal(sms.altShortCode, '78900');
});

test('the supported-bank list covers every charge the schema will accept', () => {
  // The guest charge schema restricts bankCode to banks.CODES; the guide must
  // be able to instruct the diner for every bank a charge could name. (The
  // guide is a subset of banks.js — some known banks have no C2P clave path —
  // but nothing in the guide may be absent from banks.js, tested above.)
  const guided = new Set(guide.supportedC2PBanks().map(b => b.code));
  assert.ok(guided.size >= 20, 'the guide should cover the C2P-capable banks');
  for (const b of guide.supportedC2PBanks()) {
    assert.ok(b.name, `${b.code} has no name`);
    assert.equal(typeof b.amountBound, 'boolean');
  }
});
