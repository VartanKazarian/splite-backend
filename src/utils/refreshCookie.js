const jwt = require('jsonwebtoken');

/**
 * El refresh token del personal en una cookie HttpOnly, no en el cuerpo.
 *
 * En el cuerpo, el panel lo guardaba en localStorage, donde cualquier script
 * que consiguiera correr en la página podía leerlo y llevarse la sesión entera
 * (doce horas renovables). En una cookie HttpOnly ningún script lo ve: sólo el
 * navegador lo manda, y sólo a esta API.
 *
 * Opt-in por petición (`X-Refresh-Mode: cookie`), porque sólo funciona cuando
 * la web y la API son el mismo sitio (splite.lat y api.splite.lat). Desde
 * splite.lovable.app la cookie sería de terceros y Safari la descarta, así que
 * ese cliente sigue pidiéndolo en el cuerpo como antes.
 *
 * - `__Host-`: sin Domain, Path=/ y Secure obligatorios. La cookie es sólo de
 *   api.splite.lat; ni otro subdominio puede leerla ni pisarla.
 * - `SameSite=Strict`: una página de otro sitio no consigue que el navegador la
 *   mande. splite.lat → api.splite.lat es el mismo sitio y sí la lleva.
 * - La cabecera personalizada obliga además a un preflight CORS, que sólo pasan
 *   los orígenes de CORS_ORIGINS: es la segunda defensa contra CSRF en /refresh.
 */

const COOKIE_NAME = '__Host-splite_rt';
const MODE_HEADER = 'x-refresh-mode';

function wantsCookie(req) {
  return String(req.get(MODE_HEADER) || '').toLowerCase() === 'cookie';
}

function readCookie(req) {
  const header = req.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

function cookieHeader(value, maxAgeSeconds) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/',
    'Secure',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`
  ].join('; ');
}

/**
 * Entrega una sesión recién emitida. Si el cliente pidió cookie, el refresh
 * token va en ella y sale del cuerpo (`refreshDelivery: 'cookie'` lo dice); si
 * no, el cuerpo queda como siempre. Un cuerpo sin refresh token (el reto de
 * MFA de /login) pasa tal cual.
 */
function deliverSession(req, res, body) {
  if (!body || typeof body.refreshToken !== 'string' || !wantsCookie(req)) return body;
  const { refreshToken, ...rest } = body;
  const exp = jwt.decode(refreshToken)?.exp;
  const maxAge = exp ? exp - Math.floor(Date.now() / 1000) : 0;
  res.append('Set-Cookie', cookieHeader(refreshToken, maxAge));
  return { ...rest, refreshDelivery: 'cookie' };
}

/** El refresh token de esta petición: el del cuerpo si viene, si no el de la cookie. */
function refreshTokenFrom(req) {
  if (typeof req.body?.refreshToken === 'string') return req.body.refreshToken;
  // La cookie sólo cuenta con la cabecera: una petición sin ella no es del
  // panel en modo cookie, y no se le da el beneficio de la duda.
  return wantsCookie(req) ? readCookie(req) : null;
}

function clearCookie(res) {
  res.append('Set-Cookie', cookieHeader('', 0));
}

module.exports = { COOKIE_NAME, MODE_HEADER, wantsCookie, readCookie, deliverSession, refreshTokenFrom, clearCookie };
