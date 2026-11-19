const crypto = require('crypto');

const db = require('../connectors/base');
const { logger } = require('../connectors/logger');

/**
 * Lo que pasa en los navegadores: errores y lo rápido que carga (FR4).
 *
 * Los fallos del frontend sólo le llegaban a Lovable. Nadie en Splite se
 * enteraba de que a un comensal se le rompió la cuenta, ni de que la página de
 * la mesa tarda seis segundos en un Android barato. Esto lo recoge.
 *
 * - **Errores**: una fila por huella y día en `client_errors`, y una línea en
 *   el log. La huella es el mensaje y la primera línea útil de la pila, sin
 *   números de línea de bundle (cambian con cada publicación).
 * - **Velocidad** (Web Vitals): sólo al log, en una línea con nombre fijo,
 *   para contar en Railway. Una muestra, no todas las visitas.
 *
 * Nada personal: la ruta sin consulta ni fragmento, y textos recortados.
 */

/** Quitar lo que pueda llevar un token: `?qr=…`, `#token`. */
function cleanPath(value) {
  if (typeof value !== 'string') return null;
  const path = value.split(/[?#]/)[0].slice(0, 200);
  // Los tokens de recibo compartido van en la ruta: /recibo/<token>.
  return path.replace(/^\/recibo\/.+$/, '/recibo/:token').replace(/^\/t\/.+$/, '/t/:qr');
}

function fingerprint(message, stack) {
  const frame = String(stack || '').split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('at ') || line.includes('@')) || '';
  // Sin números de línea ni hashes de archivo: cambian con cada build.
  const stable = `${message}|${frame}`.replace(/[-.][A-Za-z0-9_]{8}\.js/g, '.js').replace(/:\d+(:\d+)?/g, '');
  return crypto.createHash('sha1').update(stable).digest('hex');
}

async function recordError({ message, stack, path, surface, release, userAgent }) {
  const msg = String(message).slice(0, 500);
  const trace = stack ? String(stack).slice(0, 4000) : null;
  const where = cleanPath(path);
  const print = fingerprint(msg, trace);
  logger.warn({
    event: 'CLIENT_ERROR', fingerprint: print, message: msg, path: where, surface, release
  }, 'client error');
  await db.query(
    `INSERT INTO client_errors (fingerprint, message, stack, path, surface, release, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (day, fingerprint) DO UPDATE
       SET occurrences = client_errors.occurrences + 1, last_seen_at = NOW(),
           path = EXCLUDED.path, release = EXCLUDED.release`,
    [print, msg, trace, where, surface ?? null, release ?? null,
      userAgent ? String(userAgent).slice(0, 300) : null]
  );
}

function recordVital({ name, value, rating, path, surface, connection }) {
  logger.info({
    event: 'WEB_VITAL', name, value, rating, path: cleanPath(path), surface, connection
  }, 'web vital');
}

/** Los errores de los últimos días, los más frecuentes primero. */
async function recentErrors({ days = 7, limit = 50 } = {}) {
  const { rows } = await db.query(
    `SELECT fingerprint, MAX(message) AS message, MAX(path) AS path, MAX(surface) AS surface,
            SUM(occurrences)::int AS occurrences, MIN(first_seen_at) AS first_seen_at,
            MAX(last_seen_at) AS last_seen_at, MAX(release) AS release
       FROM client_errors
      WHERE day >= CURRENT_DATE - $1::int
      GROUP BY fingerprint
      ORDER BY SUM(occurrences) DESC, MAX(last_seen_at) DESC
      LIMIT $2`,
    [days, limit]
  );
  return rows.map(r => ({
    fingerprint: r.fingerprint, message: r.message, path: r.path, surface: r.surface,
    occurrences: r.occurrences, release: r.release,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString()
  }));
}

module.exports = { recordError, recordVital, recentErrors, cleanPath, fingerprint };
