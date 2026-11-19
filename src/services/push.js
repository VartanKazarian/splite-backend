const webPush = require('web-push');

const db = require('../connectors/base');
const { logger } = require('../connectors/logger');
const config = require('../config');
const { ApiError } = require('../errors');

/**
 * Avisos en el teléfono del personal, con la pantalla bloqueada (R19).
 *
 * El panel ya avisaba de un pago por verificar o de un pedido nuevo -- con un
 * sonido y un número --, pero sólo con la pestaña abierta y el teléfono
 * despierto. Un cajero con el teléfono en el bolsillo no se enteraba. Esto usa
 * Web Push: el navegador del teléfono se suscribe una vez, y el servidor le
 * manda un aviso cifrado a través del servicio de push de ese navegador.
 *
 * Tres reglas:
 *
 * - **Nunca rompe lo que avisa.** Un aviso se manda después de que la cosa haya
 *   pasado, sin esperar y sin lanzar: un servicio de push caído no puede
 *   tumbar un pago ni un pedido.
 * - **Nada personal en la pantalla bloqueada.** Mesa, importe, qué se pidió. Ni
 *   nombres, ni teléfonos, ni referencias bancarias.
 * - **Sólo a los servicios de push de verdad.** El servidor hace un POST a la
 *   dirección que manda el navegador; sin lista de destinos permitidos, eso es
 *   un SSRF servido en bandeja.
 */

/** Quién recibe qué. Cada uno, lo que le toca hacer. */
const AUDIENCE = {
  claim: ['OWNER', 'MANAGER', 'CASHIER'],
  order: ['OWNER', 'MANAGER', 'WAITER']
};

/**
 * Los servicios de push de los navegadores que usa el personal: Chrome y
 * Android (FCM), Firefox, Safari e iOS, Edge.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/
];

function assertPushEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { url = null; }
  if (!url || url.protocol !== 'https:' || url.port || !PUSH_HOSTS.some(host => host.test(url.hostname))) {
    throw new ApiError('VALIDATION_FAILED', 'This is not a browser push service address',
      { fields: ['endpoint'] });
  }
}

// --- Claves --------------------------------------------------------------------

let keys = null;

/**
 * El par VAPID: el del entorno si lo hay; si no, el guardado; si tampoco, uno
 * nuevo. Con dos réplicas arrancando a la vez gana la primera inserción y las
 * dos leen la misma. Se recuerda la promesa, no el resultado, para que dos
 * avisos a la vez no generen dos pares.
 */
function vapidKeys() {
  if (!keys) {
    keys = loadKeys().catch(err => {
      keys = null;
      throw err;
    });
  }
  return keys;
}

async function loadKeys() {
  if (config.push.vapidPublicKey && config.push.vapidPrivateKey) {
    return { publicKey: config.push.vapidPublicKey, privateKey: config.push.vapidPrivateKey };
  }
  const generated = webPush.generateVAPIDKeys();
  await db.query(
    `INSERT INTO push_vapid_keys (id, public_key, private_key) VALUES (1, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [generated.publicKey, generated.privateKey]
  );
  const { rows } = await db.query('SELECT public_key, private_key FROM push_vapid_keys WHERE id = 1');
  return { publicKey: rows[0].public_key, privateKey: rows[0].private_key };
}

function subject() {
  const value = config.push.subject;
  return /^(https:\/\/|mailto:)/.test(value) ? value : 'https://splite.lat';
}

/** Lo que el panel necesita para suscribirse. */
async function publicConfig() {
  if (!config.push.enabled) return { enabled: false, publicKey: null };
  return { enabled: true, publicKey: (await vapidKeys()).publicKey };
}

// --- Suscripciones -------------------------------------------------------------

async function subscribe({ restaurantId, userId, endpoint, p256dh, auth, userAgent = null }) {
  assertPushEndpoint(endpoint);
  // ON CONFLICT: el mismo teléfono, ahora con otra persona dentro, o la misma
  // que vuelve a suscribirse con claves nuevas. La fila es de quien entró
  // último.
  await db.query(
    `INSERT INTO push_subscriptions (restaurant_id, user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (endpoint) DO UPDATE
       SET restaurant_id = EXCLUDED.restaurant_id, user_id = EXCLUDED.user_id,
           p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent, failures = 0`,
    [restaurantId, userId, endpoint, p256dh, auth, userAgent ? String(userAgent).slice(0, 300) : null]
  );
}

/** Sólo la suya: nadie puede apagar los avisos del teléfono de otro. */
async function unsubscribe({ userId, endpoint }) {
  await db.query('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [userId, endpoint]);
}

/**
 * Todos los teléfonos de una persona. Lo llama `revokeAllSessionsForUser`: si
 * se le cierran las sesiones -- la dieron de baja, le cambiaron el rol, cambió
 * la contraseña --, sus avisos se cierran con ellas.
 */
async function forgetUser(userId, client = db) {
  const { rowCount } = await client.query('DELETE FROM push_subscriptions WHERE user_id = $1', [userId]);
  return rowCount;
}

// --- Envío -------------------------------------------------------------------

let send = (subscription, payload, options) => webPush.sendNotification(subscription, payload, options);

/** Para las pruebas: quién entrega en lugar del servicio de push. */
function setSender(fn) {
  const previous = send;
  send = fn;
  return () => { send = previous; };
}

/**
 * Manda un aviso a los teléfonos de esos roles en ese restaurante.
 *
 * Una suscripción que el servicio da por muerta (404, 410) se borra; cualquier
 * otro fallo suma uno y se reintenta con el aviso siguiente.
 */
async function deliver({ restaurantId, roles, message, ttlSeconds }) {
  if (!config.push.enabled) return { sent: 0, gone: 0, failed: 0 };
  const { rows } = await db.query(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth
       FROM push_subscriptions s
       JOIN users u ON u.id = s.user_id
      WHERE s.restaurant_id = $1 AND u.restaurant_id = $1
        AND u.active = true AND u.role = ANY($2::text[])`,
    [restaurantId, roles]
  );
  if (rows.length === 0) return { sent: 0, gone: 0, failed: 0 };

  const { publicKey, privateKey } = await vapidKeys();
  const payload = JSON.stringify(message);
  const options = {
    TTL: ttlSeconds,
    urgency: 'high',
    vapidDetails: { subject: subject(), publicKey, privateKey }
  };

  const outcome = { sent: 0, gone: 0, failed: 0 };
  await Promise.all(rows.map(async row => {
    try {
      await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, options);
      outcome.sent++;
      await db.query('UPDATE push_subscriptions SET last_sent_at = NOW(), failures = 0 WHERE id = $1', [row.id]);
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        outcome.gone++;
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
      } else {
        outcome.failed++;
        await db.query('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1', [row.id]);
        logger.warn({ err: err && err.message, statusCode: err && err.statusCode }, 'push: delivery failed');
      }
    }
  }));
  return outcome;
}

/** Sin esperar y sin lanzar: ver la primera regla de arriba. */
function inBackground(label, work) {
  const running = Promise.resolve()
    .then(work)
    .catch(err => {
      logger.warn({ err: err && err.message }, `push: ${label} not sent`);
      return null;
    });
  pending.add(running);
  running.finally(() => pending.delete(running));
  return running;
}

const pending = new Set();
/** Para las pruebas: hasta que salgan los avisos en curso. */
const settled = () => Promise.all([...pending]);

// --- Qué se avisa ------------------------------------------------------------

/** "45.000,00 Bs", como lo escribe el panel. */
function bolivares(minor) {
  const value = BigInt(minor);
  const whole = (value / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const cents = (value % 100n).toString().padStart(2, '0');
  return `${whole},${cents} Bs`;
}

/**
 * Un diner dijo «Ya pagué». Sólo si sigue por verificar: con una conexión
 * bancaria, `declareClaim` pudo confirmarlo ya él solo, y avisar de un pago
 * que nadie tiene que mirar es enseñar a ignorar los avisos.
 */
function paymentClaim({ restaurantId, paymentId }) {
  return inBackground('payment claim', async () => {
    const { rows } = await db.query(
      `SELECT p.status, p.amount_ves, t.name AS table_name
         FROM payments p
         JOIN bills b ON b.id = p.bill_id
         LEFT JOIN tables t ON t.id = b.table_id
        WHERE p.id = $1 AND p.restaurant_id = $2`,
      [paymentId, restaurantId]
    );
    const claim = rows[0];
    if (!claim || claim.status !== 'PENDING') return null;
    return deliver({
      restaurantId,
      roles: AUDIENCE.claim,
      ttlSeconds: 60 * 60,
      message: {
        title: claim.table_name ? `Pago por verificar · Mesa ${claim.table_name}` : 'Pago por verificar',
        body: `${bolivares(claim.amount_ves)} por Pago Móvil. Compruébalo en el banco.`,
        url: '/pagos',
        tag: `claim:${paymentId}`
      }
    });
  });
}

/** Lo pedido, en una línea: "2 × Tequeños, Hamburguesa y 3 más". */
function summarise(lines) {
  const shown = lines.slice(0, 2).map(l => (l.quantity > 1 ? `${l.quantity} × ${l.name}` : l.name));
  const rest = lines.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} y ${rest} más` : shown.join(' y ');
}

/**
 * Un pedido desde la mesa: hecho, o retenido esperando aprobación (un teléfono
 * nuevo, con la aprobación encendida). Los dos van a quien atiende la sala.
 */
function guestOrder({ restaurantId, orderId }) {
  return inBackground('guest order', async () => {
    const { rows } = await db.query(
      `SELECT o.status, o.held_items, t.name AS table_name
         FROM guest_orders o
         LEFT JOIN tables t ON t.id = o.table_id
        WHERE o.id = $1 AND o.restaurant_id = $2`,
      [orderId, restaurantId]
    );
    const order = rows[0];
    if (!order) return null;

    let lines;
    if (order.status === 'HELD') {
      lines = (order.held_items || []).map(l => ({ name: l.name, quantity: l.quantity }));
    } else if (order.status === 'PLACED') {
      lines = (await db.query(
        `SELECT name_snapshot AS name, quantity FROM bill_items
          WHERE guest_order_id = $1 AND restaurant_id = $2 ORDER BY created_at, id`,
        [orderId, restaurantId]
      )).rows;
    } else {
      return null;
    }

    const table = order.table_name ? ` · Mesa ${order.table_name}` : '';
    const held = order.status === 'HELD';
    return deliver({
      restaurantId,
      roles: AUDIENCE.order,
      // Uno retenido caduca solo; avisar después de eso es avisar de nada.
      ttlSeconds: held ? config.guest.heldOrderTimeoutSeconds : 15 * 60,
      message: {
        title: held ? `Pedido por aprobar${table}` : `Pedido nuevo${table}`,
        body: held
          ? `Primer pedido de un teléfono nuevo: ${summarise(lines)}.`
          : `${summarise(lines)}.`,
        url: '/mesas',
        tag: `order:${orderId}`
      }
    });
  });
}

/** «Enviar un aviso de prueba», a los teléfonos de quien lo pide. */
async function sendTest({ restaurantId, userId }) {
  if (!config.push.enabled) throw new ApiError('PUSH_DISABLED', 'Push notifications are switched off');
  const { rows } = await db.query(
    'SELECT role FROM users WHERE id = $1 AND restaurant_id = $2', [userId, restaurantId]);
  const { rows: mine } = await db.query(
    'SELECT COUNT(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [userId]);
  if (!rows[0] || mine[0].n === 0) {
    throw new ApiError('PUSH_NOT_SUBSCRIBED', 'Switch notifications on on this phone first');
  }
  // Sólo los de esta persona: se filtra por usuario, no por rol.
  const { publicKey, privateKey } = await vapidKeys();
  const subs = (await db.query(
    'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId])).rows;
  const payload = JSON.stringify({
    title: 'Avisos encendidos',
    body: 'Así te llegarán los pagos por verificar y los pedidos nuevos.',
    url: '/settings',
    tag: 'test'
  });
  const options = { TTL: 300, urgency: 'high', vapidDetails: { subject: subject(), publicKey, privateKey } };
  let sent = 0;
  for (const row of subs) {
    try {
      await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload, options);
      sent++;
    } catch (err) {
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        await db.query('DELETE FROM push_subscriptions WHERE id = $1', [row.id]);
      }
    }
  }
  return { sent, devices: subs.length };
}

module.exports = {
  AUDIENCE, publicConfig, subscribe, unsubscribe, forgetUser, deliver,
  paymentClaim, guestOrder, sendTest, setSender, settled, summarise, bolivares,
  assertPushEndpoint
};
