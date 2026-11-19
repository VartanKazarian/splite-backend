const { test } = require('node:test');
const assert = require('node:assert/strict');

const { cleanPath, fingerprint } = require('../src/services/clientEvents');

test('a reported path never carries a token', () => {
  assert.equal(cleanPath('/t/abc.def?qr=SECRET'), '/t/:qr');
  assert.equal(cleanPath('/recibo/eyJwIjoi.sig'), '/recibo/:token');
  assert.equal(cleanPath('/restablecer#resettoken'), '/restablecer');
  assert.equal(cleanPath('/pagos?x=1'), '/pagos');
  assert.equal(cleanPath(42), null);
});

test('the same error after a new release keeps its fingerprint', () => {
  const before = fingerprint('x is undefined', 'TypeError\n    at render (https://splite.lat/assets/GuestBillScreen-CchIibQA.js:12:345)');
  const after = fingerprint('x is undefined', 'TypeError\n    at render (https://splite.lat/assets/GuestBillScreen-Zz9Yy8Xx.js:99:1)');
  assert.equal(before, after);
  assert.notEqual(before, fingerprint('y is undefined', 'TypeError\n    at render (x.js:1:1)'));
});
