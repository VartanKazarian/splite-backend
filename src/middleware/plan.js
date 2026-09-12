const db = require('../connectors/base');
const { ApiError } = require('../errors');
const entitlements = require('../services/entitlements');

/**
 * Refuses a request the restaurant's plan does not include.
 *
 * The tier is read from the database on each gated request rather than carried
 * in the access token. A token lives fifteen minutes, and this gate stands in
 * front of issuing fiscal documents: a restaurant that upgrades should be able
 * to invoice now, and one whose plan ended should stop now, not a quarter of an
 * hour later in either direction. It is a primary-key lookup, and it only runs
 * on the routes that are actually gated.
 *
 * What this must never be put in front of is **reading** something already
 * issued. A downgrade stops a restaurant emitting new fiscal documents; the
 * legal duty to keep the ones it already emitted outlives the subscription, and
 * an invoice that becomes unreadable because an invoice went unpaid is a
 * problem Splite would have created. Gate the writes.
 */
function requirePlan(capability) {
  // Fails at startup rather than on the first request: a typo in a route's
  // gate should stop the process, not quietly refuse every caller in
  // production. `tiersOffering` throws on an unknown name.
  entitlements.tiersOffering(capability);

  return async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT plan_tier FROM restaurants WHERE id = $1',
        [req.user.restaurantId]
      );
      if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

      // Deliberately not stashed on `req`: nothing downstream needs it yet, and
      // attaching to the request after an await is the shape that hides
      // ordering bugs. A handler that needs the tier can ask for it.
      const tier = rows[0].plan_tier;

      if (!entitlements.isAllowed(tier, capability)) {
        throw new ApiError(
          'PLAN_UPGRADE_REQUIRED',
          'The restaurant plan does not include this capability',
          { capability, currentTier: tier, requiredTiers: entitlements.tiersOffering(capability) }
        );
      }
      next();
    } catch (err) { next(err); }
  };
}

/**
 * La misma puerta, para quien no llega con un token de personal.
 *
 * El comensal no tiene `req.user`: su sesión la firma el QR. Pero el plan es
 * del restaurante y no de quien pide, así que la comprobación es idéntica y lo
 * único que cambia es de dónde sale el identificador.
 */
async function assertPlanAllows(restaurantId, capability) {
  const { rows } = await db.query('SELECT plan_tier FROM restaurants WHERE id = $1', [restaurantId]);
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

  const tier = rows[0].plan_tier;
  if (!entitlements.isAllowed(tier, capability)) {
    throw new ApiError(
      'PLAN_UPGRADE_REQUIRED',
      'The restaurant plan does not include this capability',
      { capability, currentTier: tier, requiredTiers: entitlements.tiersOffering(capability) }
    );
  }
  return tier;
}

module.exports = { requirePlan, assertPlanAllows };
