const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const JWT_COMMON = { issuer: config.jwt.issuer, audience: config.jwt.audience };

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Constant-time comparison that tolerates differing lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Hash both sides so timingSafeEqual always sees equal-length input and the
  // comparison does not leak length information.
  const digestA = crypto.createHash('sha256').update(bufA).digest();
  const digestB = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

function signAccessToken(user) {
  return jwt.sign(
    { sub: user.id, restaurantId: user.restaurantId, role: user.role, type: 'access' },
    config.jwt.accessSecret,
    { ...JWT_COMMON, expiresIn: config.jwt.accessTtl, algorithm: 'HS256' }
  );
}

function signRefreshToken(user, jti) {
  return jwt.sign(
    { sub: user.id, restaurantId: user.restaurantId, role: user.role, type: 'refresh', jti },
    config.jwt.refreshSecret,
    { ...JWT_COMMON, expiresIn: config.jwt.refreshTtlSeconds, algorithm: 'HS256' }
  );
}

// algorithms is pinned on verify to block the "alg: none" / algorithm
// confusion class of attacks.
function verifyAccessToken(token) {
  return jwt.verify(token, config.jwt.accessSecret, { ...JWT_COMMON, algorithms: ['HS256'] });
}

function verifyRefreshToken(token) {
  return jwt.verify(token, config.jwt.refreshSecret, { ...JWT_COMMON, algorithms: ['HS256'] });
}

function signQrPayload(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.qrSigningSecret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyQrToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) throw new Error('Invalid QR token');
  const [body, signature] = parts;
  if (!body || !signature) throw new Error('Invalid QR token');

  const expected = crypto.createHmac('sha256', config.qrSigningSecret).update(body).digest('base64url');
  if (!safeEqual(expected, signature)) throw new Error('Invalid QR signature');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed QR payload');
  }
  if (!payload || typeof payload !== 'object') throw new Error('Malformed QR payload');
  if (!payload.tableId || !payload.restaurantId || !payload.nonce) throw new Error('Incomplete QR payload');
  if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) throw new Error('QR token expired');
  return payload;
}

module.exports = {
  hashToken,
  safeEqual,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  signQrPayload,
  verifyQrToken
};
