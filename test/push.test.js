const { test } = require('node:test');
const assert = require('node:assert/strict');

const push = require('../src/services/push');

test('amounts read the way the panel writes them', () => {
  assert.equal(push.bolivares('4500000'), '45.000,00 Bs');
  assert.equal(push.bolivares('5'), '0,05 Bs');
  assert.equal(push.bolivares('123456789'), '1.234.567,89 Bs');
});

test('an order fits on a lock screen', () => {
  assert.equal(push.summarise([{ name: 'Tequeños', quantity: 2 }]), '2 × Tequeños');
  assert.equal(push.summarise([{ name: 'Tequeños', quantity: 1 }, { name: 'Pizza', quantity: 1 }]), 'Tequeños y Pizza');
  assert.equal(
    push.summarise([
      { name: 'A', quantity: 1 }, { name: 'B', quantity: 3 }, { name: 'C', quantity: 1 }, { name: 'D', quantity: 1 }
    ]),
    'A, 3 × B y 2 más');
});

test('only the browsers\' own push services are accepted as destinations', () => {
  for (const ok of [
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/QGt',
    'https://db5p.notify.windows.com/w/?token=abc'
  ]) assert.doesNotThrow(() => push.assertPushEndpoint(ok), ok);

  for (const bad of [
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com/x',
    'http://fcm.googleapis.com/x',
    'https://fcm.googleapis.com:444/x',
    'https://localhost/x',
    'not a url'
  ]) assert.throws(() => push.assertPushEndpoint(bad), /push service/, bad);
});
