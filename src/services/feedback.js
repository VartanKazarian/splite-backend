const db = require('../connectors/base');
const { ApiError } = require('../errors');

/**
 * Lo que opina el comensal después de pagar (R20).
 *
 * Una nota del 1 al 5 y, si quiere, unas palabras. Le llega al restaurante en
 * privado, en su panel. Y a **todo** el que valora se le ofrece el enlace de
 * reseñas de Google del restaurante, si lo tiene puesto: ofrecérselo sólo a
 * quien puso 4 o 5 es lo que Google llama «solicitar selectivamente reseñas
 * positivas», está prohibido, y el castigo es que retire las reseñas del
 * restaurante.
 */

/** Sólo se valora un pago que existe de verdad: no uno rechazado o anulado. */
const RATEABLE = ['PENDING', 'SUCCEEDED'];

/**
 * Guardar (o corregir) la opinión de este comensal sobre esta cuenta.
 *
 * Una por comensal y cuenta: quien pagó en dos veces no vota dos veces, y quien
 * se equivocó de estrella la cambia en lugar de sumar otra.
 */
async function submit({ restaurantId, guestSessionId, paymentId, rating, comment }) {
  const { rows } = await db.query(
    `SELECT p.status, p.bill_id, t.name AS table_name, r.google_review_url
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       JOIN tables t ON t.id = b.table_id
       JOIN restaurants r ON r.id = p.restaurant_id
      WHERE p.id = $1 AND p.restaurant_id = $2`,
    [paymentId, restaurantId]
  );
  const payment = rows[0];
  if (!payment) throw new ApiError('PAYMENT_NOT_FOUND', 'Payment not found');
  if (!RATEABLE.includes(payment.status)) {
    throw new ApiError('PAYMENT_NOT_RATEABLE', 'Only a payment that went through can be rated',
      { status: payment.status });
  }

  const text = typeof comment === 'string' && comment.trim() ? comment.trim() : null;
  await db.query(
    `INSERT INTO diner_feedback
       (restaurant_id, bill_id, payment_id, guest_session_id, table_name, rating, comment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (bill_id, guest_session_id) DO UPDATE
       SET rating = EXCLUDED.rating, comment = EXCLUDED.comment,
           payment_id = EXCLUDED.payment_id, updated_at = NOW()`,
    [restaurantId, payment.bill_id, paymentId, guestSessionId, payment.table_name, rating, text]
  );

  return { googleReviewUrl: payment.google_review_url ?? null };
}

/**
 * Lo que ve el restaurante: la media, cuántas de cada, y las últimas.
 *
 * `days` acota el periodo (30 por defecto). Las últimas van con su mesa y su
 * fecha, nunca con nada del comensal: no lo hay.
 */
async function summary({ restaurantId, days = 30, limit = 50 }) {
  const since = `${Math.max(1, Math.min(365, days))} days`;
  const [stats, recent] = await Promise.all([
    db.query(
      `SELECT rating, COUNT(*)::int AS n
         FROM diner_feedback
        WHERE restaurant_id = $1 AND created_at >= NOW() - $2::interval
        GROUP BY rating`,
      [restaurantId, since]
    ),
    db.query(
      `SELECT id, rating, comment, table_name, created_at
         FROM diner_feedback
        WHERE restaurant_id = $1 AND created_at >= NOW() - $2::interval
        ORDER BY created_at DESC
        LIMIT $3`,
      [restaurantId, since, limit]
    )
  ]);

  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of stats.rows) distribution[row.rating] = row.n;
  const count = Object.values(distribution).reduce((a, b) => a + b, 0);
  const total = Object.entries(distribution).reduce((sum, [stars, n]) => sum + Number(stars) * n, 0);

  return {
    days: Math.max(1, Math.min(365, days)),
    count,
    // Con un decimal, como lo leería alguien: 4,3. Null sin opiniones, mejor
    // que un 0 que parecería la peor nota posible.
    average: count ? Math.round((total / count) * 10) / 10 : null,
    distribution,
    recent: recent.rows.map(row => ({
      id: row.id,
      rating: row.rating,
      comment: row.comment,
      tableName: row.table_name,
      createdAt: new Date(row.created_at).toISOString()
    }))
  };
}

/** Sólo una página de reseñas de Google: es adonde se va a mandar a la gente. */
const GOOGLE_REVIEW_HOSTS = [
  /^g\.page$/,
  /^maps\.app\.goo\.gl$/,
  /^goo\.gl$/,
  /^search\.google\.com$/,
  /^(www\.)?google\.[a-z.]{2,6}$/,
  /^maps\.google\.[a-z.]{2,6}$/
];

function isGoogleReviewUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.port && !url.username &&
    GOOGLE_REVIEW_HOSTS.some(host => host.test(url.hostname));
}

module.exports = { submit, summary, isGoogleReviewUrl, RATEABLE };
