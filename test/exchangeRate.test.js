const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseBcvPage, parseVenezuelanDecimal } = require('../src/services/exchangeRate');

// Captured verbatim from https://www.bcv.org.ve/ so the parser is tested
// against real markup rather than an idealised version of it.
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'bcv-dolar.html'), 'utf8');

test('parses the USD rate and value date out of the real BCV markup', () => {
  const { rate, valueDate } = parseBcvPage(FIXTURE);
  assert.equal(rate, 757.5406);
  assert.equal(valueDate, '2026-08-10');
});

test('reads Venezuelan number formatting, which inverts JS conventions', () => {
  // ',' is the decimal separator and '.' groups thousands.
  assert.equal(parseVenezuelanDecimal('757,54060000'), 757.5406);
  assert.equal(parseVenezuelanDecimal('1.234,56'), 1234.56);
  assert.equal(parseVenezuelanDecimal('1.234.567,89'), 1234567.89);
  assert.equal(parseVenezuelanDecimal('36,50'), 36.5);
});

test('the value date is the date the rate applies to, not the fetch time', () => {
  // BCV publishes ahead: this page was fetched on 2026-08-08 and carries a
  // value date of Monday the 10th. Anything keyed on "today" would be wrong.
  const { valueDate } = parseBcvPage(FIXTURE);
  assert.equal(valueDate, '2026-08-10');
});

test('rejects a page that does not contain the dolar block', () => {
  assert.throws(
    () => parseBcvPage('<html><body>mantenimiento</body></html>'),
    /did not contain a USD rate/
  );
});

test('rejects an implausible rate rather than trusting the match', () => {
  const zeroed = FIXTURE.replace('757,54060000', '0,00');
  assert.throws(() => parseBcvPage(zeroed), /not plausible/);
});

test('does not scan past the dolar block for a rate', () => {
  // A page where the block is gone but other <strong> elements remain must
  // fail, not silently pick up an unrelated number.
  const html = '<div id="otra"></div><strong class="strong-tb">999,00</strong>';
  assert.throws(() => parseBcvPage(html), /did not contain a USD rate/);
});

test('still returns the rate when the value date is missing', () => {
  const withoutDate = FIXTURE.replace(/Fecha\s+Valor:/i, 'Fecha:');
  const { rate, valueDate } = parseBcvPage(withoutDate);
  assert.equal(rate, 757.5406);
  assert.equal(valueDate, null, 'the rate is still correct without a parseable date');
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

test('handles the euro block being present without confusing it for USD', () => {
  const html = `
    <div id="euro"><strong class="strong-tb">881,12000000</strong></div>
    ${FIXTURE}
  `;
  assert.equal(parseBcvPage(html).rate, 757.5406);
});
