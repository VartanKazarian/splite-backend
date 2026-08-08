const { verifyAccessToken } = require('../utils/tokens');

function authenticateToken(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme !== 'Bearer' || !token || rest.length) {
    return res.status(401).json({ error: 'Access token missing' });
  }
  try {
    const claims = verifyAccessToken(token);
    if (claims.type !== 'access') return res.status(401).json({ error: 'Invalid access token' });
    if (!claims.sub || !claims.restaurantId || !claims.role) {
      return res.status(401).json({ error: 'Invalid access token' });
    }
    req.user = claims;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

/**
 * Defence in depth. Every query is already scoped by req.user.restaurantId;
 * this rejects requests that *ask* for a different tenant so the attempt is
 * visible rather than silently returning an empty result.
 */
function requireTenant(req, res, next) {
  const requested = req.params?.restaurantId || req.body?.restaurantId || req.query?.restaurantId;
  if (requested && requested !== req.user?.restaurantId) {
    return res.status(403).json({ error: 'Cross-tenant access denied' });
  }
  next();
}

module.exports = { authenticateToken, requireRole, requireTenant };
