const { ApiError } = require('../errors');
const { addContext } = require('../connectors/logger');
const operators = require('../services/operators');

/**
 * La sesión de la consola. Sólo acepta tokens de operador: están firmados con
 * otra clave y otra audiencia que los del personal, así que uno de restaurante
 * no pasa de aquí, y `authenticateToken` rechaza los de operador por lo mismo.
 *
 * Relee al operador en cada petición: desactivar a alguien corta su acceso en
 * la siguiente, sin esperar a que caduque la sesión.
 */
async function authenticateOperator(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme !== 'Bearer' || !token || rest.length) {
    return next(new ApiError('AUTH_TOKEN_MISSING', 'Access token missing'));
  }
  let claims;
  try {
    claims = operators.verifySession(token);
  } catch {
    return next(new ApiError('AUTH_TOKEN_INVALID', 'Invalid or expired token'));
  }
  try {
    const op = await operators.current(claims.sub);
    // En `res.locals` y no en `req`: lo que se asigna tras un await, donde nadie más escribe.
    res.locals.operator = { id: op.id, email: op.email, role: op.role, displayName: op.display_name };
    addContext({ operatorId: op.id });
    next();
  } catch (err) {
    next(err);
  }
}

/** Escribir es de ADMIN; SUPPORT sólo mira. */
function requireOperatorRole(...roles) {
  return (req, res, next) => {
    const op = res.locals.operator;
    if (!op || !roles.includes(op.role)) {
      return next(new ApiError('FORBIDDEN_ROLE', 'Forbidden', { requiredRoles: roles }));
    }
    next();
  };
}

module.exports = { authenticateOperator, requireOperatorRole };
