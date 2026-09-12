const db = require('../connectors/base');

/**
 * El contacto que deja un comensal, con la finalidad separada del dato.
 *
 * La regla que ordena este módulo: **dar el correo para recibir una factura no
 * es consentir publicidad.** Son dos finalidades y se guardan como dos cosas,
 * porque la única forma de defender la segunda es poder enseñar cuándo se dio
 * y desde dónde.
 *
 * De ahí salen dos comportamientos que parecen detalles y no lo son:
 *
 *   - Volver a dejar el correo **no** reactiva un consentimiento retirado. Si
 *     alguien se dio de baja y luego cena otra vez y pide su factura, sigue de
 *     baja: no se ha vuelto a ofrecer nada ni ha vuelto a decir que sí.
 *
 *   - Un `false` **nunca** pisa un `true` por omisión. Un cliente que no manda
 *     el campo no está retirando nada; para eso está `withdraw`.
 */

/** Minúsculas y sin espacios, para que Ana@X.com y ana@x.com sean uno. */
const normalise = email => String(email).trim().toLowerCase();

/**
 * Guarda o actualiza el contacto de un comensal.
 *
 * `marketingConsent` sólo puede llegar a `true` cuando alguien marcó una
 * casilla vacía; el esquema de la ruta no lo deja por defecto y aquí tampoco se
 * infiere de nada.
 */
async function upsert({ restaurantId, billId, email, name, marketingConsent, source }) {
  const address = normalise(email);
  const consented = marketingConsent === true;

  const { rows } = await db.query(
    `INSERT INTO guest_contacts
       (restaurant_id, bill_id, email, name, invoice_opt_in,
        marketing_consent, consent_at, consent_source)
     VALUES ($1, $2, $3, $4, true, $5, CASE WHEN $5 THEN now() ELSE NULL END, $6)
     ON CONFLICT (restaurant_id, lower(email)) DO UPDATE SET
       -- El nombre se actualiza si viene uno; no se borra el que había con un
       -- envío que simplemente no lo trae.
       name = COALESCE(EXCLUDED.name, guest_contacts.name),
       -- Aquí está toda la política, en una expresión:
       --
       -- Sólo pasa a true si en ESTA vez dijo que sí **y** no está dado de
       -- baja. Y nunca baja a false por omisión -- se queda como estaba --
       -- porque no mandar el campo no es retirar nada.
       marketing_consent = CASE
         WHEN guest_contacts.withdrawn_at IS NOT NULL THEN false
         WHEN $5 THEN true
         ELSE guest_contacts.marketing_consent
       END,
       consent_at = CASE
         WHEN guest_contacts.withdrawn_at IS NOT NULL THEN guest_contacts.consent_at
         WHEN $5 AND NOT guest_contacts.marketing_consent THEN now()
         ELSE guest_contacts.consent_at
       END,
       consent_source = CASE
         WHEN guest_contacts.withdrawn_at IS NULL AND $5 AND NOT guest_contacts.marketing_consent
           THEN $6
         ELSE guest_contacts.consent_source
       END,
       bill_id = COALESCE(EXCLUDED.bill_id, guest_contacts.bill_id)
     RETURNING id, email, name, marketing_consent, consent_at, withdrawn_at`,
    [restaurantId, billId ?? null, address, name ?? null, consented, source ?? 'GUEST_CHECKOUT']
  );
  return rows[0];
}

/**
 * Da de baja del envío comercial, conservando la fila.
 *
 * No se borra a propósito: borrarla perdería la prueba de que el
 * consentimiento existió, que es exactamente lo que habría que enseñar si
 * alguien reclama haber recibido un correo que no pidió. Y además dejaría la
 * puerta abierta a que el mismo correo volviera a entrar en la lista sin que
 * nadie lo hubiera vuelto a aceptar.
 */
async function withdraw({ restaurantId, email }) {
  const { rows } = await db.query(
    `UPDATE guest_contacts
        SET marketing_consent = false, withdrawn_at = now()
      WHERE restaurant_id = $1 AND lower(email) = lower($2)
      RETURNING id, email, withdrawn_at`,
    [restaurantId, normalise(email)]
  );
  return rows[0] ?? null;
}

/** La lista que el restaurante puede usar de verdad. */
async function listConsented({ restaurantId, limit = 100, offset = 0 }) {
  const { rows } = await db.query(
    `SELECT id, email, name, consent_at
       FROM guest_contacts
      WHERE restaurant_id = $1 AND marketing_consent = true AND withdrawn_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [restaurantId, limit, offset]
  );
  return rows;
}

module.exports = { upsert, withdraw, listConsented, normalise };
