const test = require('node:test');
const assert = require('node:assert/strict');
const { signQrPayload, verifyQrToken, signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, safeEqual } = require('../src/utils/tokens');

const future = () => Math.floor(Date.now() / 1000) + 60;
const qr = (overrides = {}) => signQrPayload({ v: 1, tableId: 't', restaurantId: 'r', nonce: 'n', exp: future(), ...overrides });

test('QR token round trip preserves the payload', () => {
  const payload = verifyQrToken(qr());
  assert.equal(payload.tableId, 't');
  assert.equal(payload.restaurantId, 'r');
});

test('QR token rejects a tampered body', () => {
  const [body, sig] = qr().split('.');
  assert.throws(() => verifyQrToken(`${body}x.${sig}`), /Invalid QR signature/);
});

test('QR token rejects a tampered signature', () => {
  const [body, sig] = qr().split('.');
  assert.throws(() => verifyQrToken(`${body}.${sig.slice(0, -1)}A`), /Invalid QR signature/);
});

test('QR token rejects an expired payload', () => {
  assert.throws(() => verifyQrToken(qr({ exp: Math.floor(Date.now() / 1000) - 1 })), /expired/);
});

test('QR token rejects a payload missing required claims', () => {
  assert.throws(() => verifyQrToken(signQrPayload({ exp: future() })), /Incomplete QR payload/);
});

test('QR token rejects malformed input', () => {
  for (const bad of [null, '', 'abc', 'a.b.c']) {
    assert.throws(() => verifyQrToken(bad));
  }
});

test('access and refresh tokens are not interchangeable', () => {
  const user = { id: 'u1', restaurantId: 'r1', role: 'OWNER' };
  const access = signAccessToken(user);
  const refresh = signRefreshToken(user, 'jti-1');

  assert.equal(verifyAccessToken(access).type, 'access');
  assert.equal(verifyRefreshToken(refresh).type, 'refresh');
  // Distinct signing secrets mean a refresh token cannot authenticate a request.
  assert.throws(() => verifyAccessToken(refresh));
  assert.throws(() => verifyRefreshToken(access));
});

test('access token carries tenant and role claims', () => {
  const claims = verifyAccessToken(signAccessToken({ id: 'u1', restaurantId: 'r1', role: 'CASHIER' }));
  assert.equal(claims.sub, 'u1');
  assert.equal(claims.restaurantId, 'r1');
  assert.equal(claims.role, 'CASHIER');
});

test('safeEqual compares values without throwing on length mismatch', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'x'), false);
});
