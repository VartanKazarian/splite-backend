const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseMenuPrice } = require('../src/services/menuPrice');
const { toDraftItems, isConfigured } = require('../src/services/menuOcr');
const config = require('../src/config');

/**
 * The menu reader, tested where it decides things: what a price on a menu means,
 * and what happens to a row the model got wrong. The network call is not tested
 * here — what matters is what we do with the answer, not that fetch works.
 */

// --- Prices ----------------------------------------------------------------

test('a menu price is read in whole units, both separator conventions', () => {
  // The two ways a price is written in the wild, and the reason this is not the
  // bank parser: a bank sometimes quotes minor units, a menu never does.
  assert.equal(parseMenuPrice('12,50'), '1250');       // es-VE decimal comma
  assert.equal(parseMenuPrice('12.50'), '1250');       // en decimal dot
  assert.equal(parseMenuPrice('1.234,56'), '123456');  // es-VE grouped
  assert.equal(parseMenuPrice('1,234.56'), '123456');  // en grouped
  assert.equal(parseMenuPrice('25'), '2500');          // bare: 25 bolívares, not 25 céntimos
});

test('a decimal point is not mistaken for a thousands separator', () => {
  // The bug this parser exists to avoid: stripping every dot turns 25.00 into
  // 2500 and prices the dish a hundred times too high. It survives a casual
  // test because comma-decimals happen to come out right.
  assert.equal(parseMenuPrice('25.00'), '2500', 'Bs. 25,00 — not 2500,00');
  assert.equal(parseMenuPrice('$5.00'), '500', 'five dollars — not five hundred');
  assert.equal(parseMenuPrice('8.50'), '850');
});

test('three trailing digits are thousands, not a fraction', () => {
  // "1.500" on a Venezuelan menu is one thousand five hundred, and a currency
  // has at most two decimal places anyway.
  assert.equal(parseMenuPrice('1.500'), '150000');
  assert.equal(parseMenuPrice('1,500'), '150000');
});

test('currency marks and trailing words are stripped, not parsed', () => {
  assert.equal(parseMenuPrice('Bs. 25,00'), '2500');
  assert.equal(parseMenuPrice('Bs.100'), '10000');
  assert.equal(parseMenuPrice('€12,50'), '1250');
  assert.equal(parseMenuPrice('12,50 c/u'), '1250');
});

test('an unreadable price is null, never a guess', () => {
  // Null routes the row to a human. Guessing puts a wrong price on a menu with
  // nobody knowing it was guessed.
  for (const bad of ['', '   ', 'a la carta', 'S/P', null, undefined, '12,3456', '1.2.3,4,5']) {
    assert.equal(parseMenuPrice(bad), null, `${JSON.stringify(bad)} should need review`);
  }
});

test('a free item is zero, not unreadable', () => {
  assert.equal(parseMenuPrice('0'), '0');
  assert.equal(parseMenuPrice('0,00'), '0');
});

// --- Drafting --------------------------------------------------------------

const payload = (items, extra = {}) => ({ items, currencyGuess: 'VES', notes: null, ...extra });

test('a row the model could not price is kept and flagged, not dropped', () => {
  const drafts = toDraftItems(
    payload([{ name: 'Pizza Margarita', priceText: null }]),
    { currency: 'VES' }
  );
  assert.equal(drafts.length, 1, 'the item is real even though its price is not readable');
  assert.equal(drafts[0].priceMinorUnits, null);
  assert.equal(drafts[0].needsPrice, true);
});

test('rows sharing a name are flagged, since the menu is unique on name', () => {
  const drafts = toDraftItems(
    payload([
      { name: 'Café', priceText: '2,00' },
      { name: 'café', priceText: '2,50' },
      { name: 'Té', priceText: '2,00' }
    ]),
    { currency: 'VES' }
  );
  assert.equal(drafts.find(d => d.name === 'Café').duplicateName, true);
  assert.equal(drafts.find(d => d.name === 'café').duplicateName, true, 'case-insensitive');
  assert.equal(drafts.find(d => d.name === 'Té').duplicateName, false);
});

test('a nameless row is not an item', () => {
  const drafts = toDraftItems(
    payload([{ name: '   ', priceText: '5,00' }, { priceText: '6,00' }]),
    { currency: 'VES' }
  );
  assert.deepEqual(drafts, []);
});

test('every row carries the price as printed beside the parsed value', () => {
  // The reviewer is checking one against the other, so losing the original
  // would remove the only thing they can verify against.
  const drafts = toDraftItems(payload([{ name: 'Pasta', priceText: 'Bs. 25,00' }]), { currency: 'VES' });
  assert.equal(drafts[0].priceText, 'Bs. 25,00');
  assert.equal(drafts[0].priceMinorUnits, '2500');
  assert.equal(drafts[0].currency, 'VES');
});

test('long fields are bounded to what the column holds', () => {
  const drafts = toDraftItems(
    payload([{ name: 'x'.repeat(400), description: 'y'.repeat(900), priceText: '1,00' }]),
    { currency: 'VES' }
  );
  assert.equal(drafts[0].name.length, 160);
  assert.equal(drafts[0].description.length, 500);
});

test('a malformed provider payload yields no items rather than throwing', () => {
  for (const bad of [null, undefined, {}, { items: null }, { items: 'nope' }]) {
    assert.deepEqual(toDraftItems(bad, { currency: 'VES' }), []);
  }
});

// --- What this deployment can do -------------------------------------------

test('the reader reports itself unavailable without a key', () => {
  // The flag the settings endpoint publishes. It is what lets a client hide the
  // photo import instead of offering it, letting somebody choose a file, waiting
  // for several megabytes to upload, and only then answering 503.
  const key = config.menuOcr.apiKey;
  const base = config.menuOcr.baseUrl;
  try {
    config.menuOcr.apiKey = '';
    assert.equal(isConfigured(), false, 'no key means the feature is off here');

    config.menuOcr.apiKey = 'sk-test';
    assert.equal(isConfigured(), true);

    // Both halves are required: a key with nowhere to send it is not a working
    // reader, and the base URL is what selects the vendor.
    config.menuOcr.baseUrl = '';
    assert.equal(isConfigured(), false);
  } finally {
    config.menuOcr.apiKey = key;
    config.menuOcr.baseUrl = base;
  }
});
