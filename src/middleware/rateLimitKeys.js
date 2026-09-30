const { verifyAccessToken } = require('../utils/tokens');

/**
 * Qué cuenta cada limitador, para los que corren antes de autenticar.
 *
 * `rateLimit` salta la petición cuando la identidad es `null`, así que estas
 * funciones deciden dos cosas a la vez: a quién se le cuenta y a quién no.
 */

/**
 * El miembro del personal que llama, sólo si su token es válido.
 *
 * Se verifica la firma antes de contar: un `sub` leído sin verificar dejaría
 * a cualquiera abrirse un cubo nuevo por petición inventándose el token. Un
 * token falso o caducado no cuenta aquí -- vale el límite por dirección de
 * `/api/v1`, y la ruta lo rechazará igual al autenticar.
 */
function staffSubject(req) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  try {
    const claims = verifyAccessToken(token);
    return claims && claims.sub ? String(claims.sub) : null;
  } catch {
    return null;
  }
}

/**
 * Rutas de `/api/v1/auth` que no adivinan nada.
 *
 * El límite de diez por dirección está para que nadie pruebe contraseñas,
 * códigos o invitaciones a mansalva. Leer la sesión, renovarla con un token
 * de 256 bits o cerrarla no prueba nada: se paga con el límite por miembro del
 * personal. Contarlas aquí dejaba sin panel a un restaurante cuyos tres
 * teléfonos comparten el wifi del local, porque el panel lee la sesión en cada
 * pantalla.
 */
const AUTH_NOT_A_GUESS = new Set([
  'GET /me',
  'PATCH /me',
  'GET /mfa',
  'POST /mfa/enrol',
  'POST /refresh',
  'POST /logout'
]);

/** La dirección, salvo en las rutas de arriba, que no cuentan. */
function credentialAttempt(req) {
  return AUTH_NOT_A_GUESS.has(`${req.method} ${req.path}`) ? null : (req.ip || 'unknown');
}

module.exports = { staffSubject, credentialAttempt, AUTH_NOT_A_GUESS };
