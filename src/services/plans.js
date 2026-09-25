const db = require('../connectors/base');
const { ApiError } = require('../errors');
const entitlements = require('./entitlements');

/**
 * Cambiar de plan a un restaurante que ya existe.
 *
 * Hasta aquí `plan_tier` se escribía **una sola vez**, en el alta, siempre como
 * TRIAL, y nada volvía a tocarlo. Vender un plan significaba entrar a la base
 * de producción con un UPDATE a mano: sin validar, sin dejar rastro, y sin
 * enterarse de lo que el cambio le quitaba al restaurante.
 *
 * Vive en un servicio y no dentro del script por lo mismo que dice
 * `scripts/onboarding.js`: si algún día hay una consola de operador, que llame
 * a esto y no reimplemente la regla.
 *
 * ## El rastro va dentro de la transacción
 *
 * `logAudit` se traga sus fallos a propósito -- un apunte de auditoría que no
 * se escribe no puede tumbar el cobro que lo provocó. Aquí es al revés: **el
 * apunte es lo único que queda**. No hay petición HTTP, no hay usuario, no hay
 * nada más que registre que alguien cambió esto. Así que se escribe en la misma
 * transacción que el UPDATE: si no se puede dejar rastro, el plan no cambia.
 *
 * Y sacarlo de ahí no es sólo perder la garantía: **se cuelga**.
 * `audit_logs.restaurant_id` referencia `restaurants(id)`, así que insertar el
 * apunte pide un `FOR KEY SHARE` sobre la misma fila que esta transacción tiene
 * bloqueada con `FOR UPDATE` más abajo. Escribirlo por otra conexión se espera
 * a sí mismo hasta el `statement_timeout`. Medido, no supuesto: cambiar
 * `client.query` por `db.query` aquí deja las pruebas en «canceling statement
 * due to statement timeout».
 */

/**
 * Cómo se sabe si una capacidad **ya está en uso**.
 *
 * Sólo hace falta para las que de verdad rechazan (`ENFORCED`): quitar una que
 * no se refuerza no le quita nada a nadie hoy. Para las que sí, bajar de plan
 * es lo que deja a un restaurante sin poder hacer algo que venía haciendo, y
 * eso tiene que costar un `--force` en vez de pasar en silencio.
 */
const USAGE = {
  fiscalInvoicing: {
    sql: 'SELECT count(*)::INT AS n FROM fiscal_invoices WHERE restaurant_id = $1',
    // En pasado: son documentos ya emitidos, y ésa es la razón de parar.
    describe: n => `ya ha emitido ${n} factura(s) fiscal(es)`
  }
};

/**
 * El restaurante, buscado por lo que uno tenga a mano.
 *
 * Tres formas, y la del correo es la que se usa de verdad: quien vende un plan
 * sabe con quién habló, no el UUID de su restaurante ni siempre su RIF. Sin
 * ella el primer paso era una consulta a mano contra la base -- justo lo que
 * este servicio existe para quitar de en medio.
 *
 * El correo no es ambiguo: `users_email_unique_idx` (migración 002) lo hace
 * único en toda la plataforma, no sólo dentro de un restaurante, porque si no
 * el login no sabría a cuál entrar. Así que un correo apunta a un dueño y un
 * dueño a un restaurante.
 */
async function find({ restaurantId = null, rif = null, email = null }) {
  const { rows } = await db.query(
    `SELECT r.id, r.name, r.rif, r.plan_tier, r.trial_ends_at, r.created_at
       FROM restaurants r
      WHERE ($1::UUID IS NOT NULL AND r.id = $1::UUID)
         OR ($2::TEXT IS NOT NULL AND r.rif = $2::TEXT)
         OR ($3::TEXT IS NOT NULL AND r.id = (
              SELECT u.restaurant_id FROM users u WHERE lower(u.email) = lower($3::TEXT)
            ))`,
    [restaurantId, rif, email]
  );
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
  return rows[0];
}

async function listByTier(tier = null) {
  if (tier && !entitlements.TIERS.includes(tier)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown tier ${tier}`,
      { allowed: entitlements.TIERS });
  }
  const { rows } = await db.query(
    `SELECT id, name, rif, plan_tier, trial_ends_at
       FROM restaurants
      WHERE $1::TEXT IS NULL OR plan_tier = $1::TEXT
      ORDER BY plan_tier, name`,
    [tier]
  );
  return rows;
}

/** Qué gana y qué pierde, por nombre de capacidad. */
function diff(from, to) {
  const before = entitlements.capabilitiesFor(from);
  const after = entitlements.capabilitiesFor(to);
  return {
    gained: entitlements.CAPABILITIES.filter(c => !before[c] && after[c]),
    lost: entitlements.CAPABILITIES.filter(c => before[c] && !after[c])
  };
}

/**
 * Cambia el plan.
 *
 * `trialDays` sólo tiene sentido yendo a TRIAL. Saliendo de TRIAL la fecha se
 * **borra**, y no por limpieza: el panel pinta el aviso de prueba mientras haya
 * una, así que dejarla puesta le enseñaría «tu prueba termina el día tal» a un
 * restaurante que acaba de pagar.
 */
async function change({ restaurantId, tier, trialDays = null, note = null, force = false,
  operator = null, meta = {} }) {
  if (!entitlements.TIERS.includes(tier)) {
    throw new ApiError('VALIDATION_FAILED', `Unknown tier ${tier}`,
      { allowed: entitlements.TIERS });
  }

  return db.withTransaction(async (client) => {
    // Bloqueada mientras se decide: entre leer el plan de ahora y escribir el
    // nuevo no puede colarse otro cambio, o el rastro diría que se pasó de un
    // plan del que ya no se venía.
    const { rows } = await client.query(
      `SELECT id, name, rif, plan_tier, trial_ends_at
         FROM restaurants WHERE id = $1 FOR UPDATE`,
      [restaurantId]
    );
    if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
    const before = rows[0];

    const changes = diff(before.plan_tier, tier);

    // Lo que se va a romper, si es que se rompe algo. Se mira antes de escribir
    // y se cuenta entero: enterarse de que el restaurante no puede facturar
    // cuando un comensal lo pide es tarde.
    const breaking = [];
    for (const capability of changes.lost) {
      const usage = entitlements.ENFORCED.has(capability) ? USAGE[capability] : null;
      if (!usage) continue;
      const { rows: used } = await client.query(usage.sql, [restaurantId]);
      if (used[0].n > 0) breaking.push({ capability, detail: usage.describe(used[0].n) });
    }
    if (breaking.length && !force) {
      throw new ApiError('PLAN_DOWNGRADE_BLOCKED',
        'This downgrade removes a capability the restaurant is already using',
        { from: before.plan_tier, to: tier, breaking });
    }

    const updated = await client.query(
      `UPDATE restaurants
          SET plan_tier = $2::TEXT,
              trial_ends_at = CASE
                WHEN $2::TEXT <> 'TRIAL' THEN NULL
                WHEN $3::INT IS NOT NULL THEN NOW() + ($3::INT * INTERVAL '1 day')
                ELSE trial_ends_at
              END,
              updated_at = NOW()
        WHERE id = $1
      RETURNING id, name, rif, plan_tier, trial_ends_at`,
      [restaurantId, tier, trialDays]
    );

    /*
     * El apunte, aquí dentro y a mano.
     *
     * No se usa `logAudit` porque se traga los fallos, que es lo correcto
     * colgando de una petición y lo contrario de lo que hace falta aquí: este
     * apunte es el único registro de que el plan cambió, quién lo pidió y desde
     * qué plan. Si no se puede escribir, el UPDATE se va con él.
     */
    await client.query(
      `INSERT INTO audit_logs (restaurant_id, action, resource_type, resource_id, details)
       VALUES ($1, 'PLAN_CHANGED', 'restaurant', $1, $2)`,
      [restaurantId, JSON.stringify({
        from: before.plan_tier,
        to: tier,
        // Desde la línea de comandos no hay forma de saber quién fue; desde la
        // consola sí, y va además en `operator_audit` con su id.
        via: operator ? 'console' : 'cli',
        operatorEmail: operator ? operator.email : undefined,
        note,
        forced: breaking.length > 0,
        breaking: breaking.length ? breaking : undefined,
        gained: changes.gained,
        lost: changes.lost
      })]
    );

    if (operator) {
      await client.query(
        `INSERT INTO operator_audit
           (operator_id, action, restaurant_id, resource_type, resource_id, details, ip, user_agent, request_id)
         VALUES ($1, 'PLAN_CHANGED', $2, 'restaurant', $2, $3, $4, $5, $6)`,
        [operator.id, restaurantId,
          JSON.stringify({ from: before.plan_tier, to: tier, note, forced: breaking.length > 0, trialDays }),
          meta.ip || null, meta.userAgent ? String(meta.userAgent).slice(0, 512) : null, meta.requestId || null]
      );
    }

    return { before, after: updated.rows[0], changes, breaking };
  });
}

module.exports = { find, listByTier, change, diff, _internals: { USAGE } };
