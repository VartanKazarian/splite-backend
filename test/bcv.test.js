const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBcvPage, parseVenezuelanDecimal } = require('../src/connectors/bcv');

// Captured verbatim from https://www.bcv.org.ve/ so the parser is tested
// against real markup rather than an idealised version of it.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'bcv-rates.html'), 'utf8');

test('parses both published rates and the value date out of the real BCV markup', () => {
  const { rates, valueDate } = parseBcvPage(FIXTURE);
  assert.equal(rates.USD, 757.5406);
  assert.equal(rates.EUR, 875.2169568);
  assert.equal(valueDate, '2026-08-10');
});

test('does not confuse one currency block for another', () => {
  // The page carries yuan, lira and rublo blocks too. A lookahead that ran on
  // past its own block would attach a plausible number to the wrong currency.
  const { rates } = parseBcvPage(FIXTURE);
  assert.notEqual(rates.USD, rates.EUR);
  assert.deepEqual(Object.keys(rates).sort(), ['EUR', 'USD']);
});

test('reads Venezuelan number formatting, which inverts JS conventions', () => {
  // ',' is the decimal separator and '.' groups thousands.
  assert.equal(parseVenezuelanDecimal('757,54060000'), 757.5406);
  assert.equal(parseVenezuelanDecimal('1.234,56'), 1234.56);
  assert.equal(parseVenezuelanDecimal('1.234.567,89'), 1234567.89);
  assert.equal(parseVenezuelanDecimal('36,50'), 36.5);
});

test('the value date is the date the rates apply to, not the fetch time', () => {
  // BCV publishes ahead, so anything keyed on "today" would be wrong.
  assert.equal(parseBcvPage(FIXTURE).valueDate, '2026-08-10');
});

test('rejects a page that contains no rate at all', () => {
  assert.throws(
    () => parseBcvPage('<html><body>mantenimiento</body></html>'),
    /did not contain any rate/
  );
});

test('does not scan past a missing block for a rate', () => {
  const html = '<div id="otra"></div><strong class="strong-tb">999,00</strong>';
  assert.throws(() => parseBcvPage(html), /did not contain any rate/);
});

test('still returns the rates when the value date is missing', () => {
  const withoutDate = FIXTURE.replace(/Fecha\s+Valor:/i, 'Fecha:');
  const { rates, valueDate } = parseBcvPage(withoutDate);
  assert.equal(rates.USD, 757.5406);
  assert.equal(valueDate, null, 'the rates are still correct without a parseable date');
});

test('the bundled BCV intermediate is present, correct and unexpired', () => {
  // bcv.org.ve presents the wrong Sectigo intermediate, so this certificate is
  // what makes TLS verification succeed. If it goes missing (note .gitignore
  // excludes *.pem by default) or expires, the rate lookup starts failing in
  // production while still passing every other test here.
  const { X509Certificate } = require('node:crypto');
  const pem = fs.readFileSync(
    path.join(__dirname, '..', 'certs', 'sectigo-public-server-auth-dv-r36.pem'),
    'utf8'
  );
  const cert = new X509Certificate(pem);

  assert.match(cert.subject, /Sectigo Public Server Authentication CA DV R36/);
  assert.ok(new Date(cert.validTo) > new Date(), `bundled intermediate expired on ${cert.validTo}`);
});

