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
  // Flip to a character the signature does not already end with. Hardcoding
  // 'A' made this a no-op whenever the signature happened to end in 'A' --
  // about one run in 64, since the payload carries a per-second timestamp.
  const tampered = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
  assert.notEqual(tampered, sig);
  assert.throws(() => verifyQrToken(`${body}.${tampered}`), /Invalid QR signature/);
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

test('a QR without an expiry is permanent, because it is printed on furniture', () => {
  // The default. A code that stops scanning after a month means reprinting
  // every sticker in the restaurant; the nonce is what revokes one.
  const permanent = signQrPayload({ v: 1, tableId: 't', restaurantId: 'r', nonce: 'n', iat: 1 });
  const payload = verifyQrToken(permanent);
  assert.equal(payload.tableId, 't');
  assert.equal(payload.exp, undefined);
});

test('an expiry is still honoured when one is set', () => {
  // A deployment that wants short-lived codes -- a printed receipt rather than
  // a table sticker -- keeps the old behaviour by setting QR_TTL_SECONDS.
  assert.equal(verifyQrToken(qr({ exp: future() })).tableId, 't');
  assert.throws(() => verifyQrToken(qr({ exp: Math.floor(Date.now() / 1000) - 1 })), /expired/);
});

test('an expiry cannot be stripped to manufacture a permanent code', () => {
  // The payload is signed whole, so editing it invalidates the signature.
  const expiring = qr({ exp: Math.floor(Date.now() / 1000) - 1 });
  const [body] = expiring.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  delete payload.exp;
  const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${expiring.split('.')[1]}`;

  assert.throws(() => verifyQrToken(forged), /Invalid QR signature/);
});
