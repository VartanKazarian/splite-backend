const { verifyAccessToken } = require('../utils/tokens');
const { addContext } = require('../connectors/logger');
const { ApiError } = require('../errors');

function authenticateToken(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme !== 'Bearer' || !token || rest.length) {
    return next(new ApiError('AUTH_TOKEN_MISSING', 'Access token missing'));
  }
  try {
    const claims = verifyAccessToken(token);
    if (claims.type !== 'access') return next(new ApiError('AUTH_TOKEN_INVALID', 'Invalid access token'));
    if (!claims.sub || !claims.restaurantId || !claims.role) {
      return next(new ApiError('AUTH_TOKEN_INVALID', 'Invalid access token'));
    }
    req.user = claims;
    // Every later log line for this request now carries who and which tenant,
    // which is what makes a per-restaurant view of failures possible at all.
    addContext({ userId: claims.sub, restaurantId: claims.restaurantId, role: claims.role });
    next();
  } catch {
    return next(new ApiError('AUTH_TOKEN_INVALID', 'Invalid or expired token'));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new ApiError('FORBIDDEN_ROLE', 'Forbidden', { requiredRoles: roles }));
    }
    next();
  };
}

module.exports = { authenticateToken, requireRole };
