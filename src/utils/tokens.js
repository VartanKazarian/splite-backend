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

/** `ttlSeconds` lets a rotation stop at the session's absolute cap. */
function signRefreshToken(user, jti, ttlSeconds = config.jwt.refreshTtlSeconds) {
  return jwt.sign(
    { sub: user.id, restaurantId: user.restaurantId, role: user.role, type: 'refresh', jti },
    config.jwt.refreshSecret,
    { ...JWT_COMMON, expiresIn: Math.max(1, Math.floor(ttlSeconds)), algorithm: 'HS256' }
  );
}

/**
 * The token that stands between a correct password and a session.
 *
 * Signed with the access secret but carrying `type: 'mfa_challenge'`, which
 * `authenticateToken` already refuses -- it checks for `type === 'access'` and
 * rejects anything else, so a challenge cannot be presented as a session. That
 * check is what makes reusing the secret safe, and it is the reason this does
 * not introduce a fifth one.
 *
 * It names the user and nothing else useful: no role, no restaurant. A
 * challenge is not authorisation, and the login path re-reads the user anyway
 * before issuing anything.
 */
function signMfaChallenge(userId) {
  return jwt.sign(
    { sub: userId, type: 'mfa_challenge' },
    config.jwt.accessSecret,
    { ...JWT_COMMON, expiresIn: config.mfa.challengeTtlSeconds, algorithm: 'HS256' }
  );
}

function verifyMfaChallenge(token) {
  const claims = jwt.verify(token, config.jwt.accessSecret, { ...JWT_COMMON, algorithms: ['HS256'] });
  // Belt and braces against the mirror of the risk above: an *access* token
  // must not be usable as a challenge either, or a stolen one would let its
  // holder complete somebody's half-finished login.
  if (claims.type !== 'mfa_challenge' || !claims.sub) throw new Error('Not an MFA challenge');
  return claims;
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
  // A QR carries no expiry by default, because it is printed onto furniture.
  // A code that stops scanning after a month means reprinting every table's
  // sticker, and the clock is the wrong control here: rotating the table's
  // nonce revokes every code already printed for it, immediately and by
  // intent. `exp` is honoured when a deployment chooses to set one.
  //
  // It cannot be stripped to manufacture permanence: the payload is signed
  // whole, so removing the field invalidates the signature.
  if (payload.exp !== undefined) {
    if (!Number.isInteger(payload.exp) || payload.exp < Math.floor(Date.now() / 1000)) {
      throw new Error('QR token expired');
    }
  }
  return payload;
}

/**
 * A link to one receipt that a diner can send themselves on WhatsApp (R20).
 *
 * Signed with the QR secret but under its own label, so neither token can be
 * replayed as the other: a QR signature is the HMAC of the body, this one is
 * the HMAC of `receipt-link:` + the body. No new secret to configure, and no
 * table to store links in -- the link is the proof.
 */
const RECEIPT_LINK_LABEL = 'receipt-link:v1:';

function signReceiptLink({ paymentId, restaurantId, ttlSeconds }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const body = Buffer.from(JSON.stringify({ p: paymentId, r: restaurantId, exp })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.qrSigningSecret)
    .update(RECEIPT_LINK_LABEL + body).digest('base64url');
  return { token: `${body}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}

/** `{ paymentId, restaurantId }`, or null for anything forged, mangled or expired. */
function verifyReceiptLink(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac('sha256', config.qrSigningSecret)
    .update(RECEIPT_LINK_LABEL + body).digest('base64url');
  if (!safeEqual(expected, signature)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.p || !payload.r || !Number.isInteger(payload.exp)) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return { paymentId: payload.p, restaurantId: payload.r };
}

module.exports = {
  signReceiptLink,
  verifyReceiptLink,
  hashToken,
  safeEqual,
  signAccessToken,
  signRefreshToken,
  signMfaChallenge,
  verifyMfaChallenge,
  verifyAccessToken,
  verifyRefreshToken,
  signQrPayload,
  verifyQrToken
};
