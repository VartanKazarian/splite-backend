const { ApiError } = require('../errors');

/**
 * Lo único que quita no pagar: abrir cuentas nuevas.
 *
 * Sólo cuando alguien de Splite suspende o cancela la suscripción desde la
 * consola; nada se corta solo por un cargo vencido. Y aun suspendido, lo que
 * ya está abierto sigue: las mesas con cuenta se pueden pedir, dividir y
 * pagar. Un comensal no se queda nunca sin poder pagar por un asunto entre el
 * restaurante y Splite.
 */
async function assertMayOpenBills(client, restaurantId) {
  const { rows } = await client.query(
    'SELECT status FROM restaurant_subscriptions WHERE restaurant_id = $1',
    [restaurantId]
  );
  const status = rows[0]?.status;
  if (status === 'SUSPENDED' || status === 'CANCELLED') {
    throw new ApiError('SUBSCRIPTION_SUSPENDED',
      'The subscription is suspended: open tables keep working, new bills cannot be opened',
      { status });
  }
}

module.exports = { assertMayOpenBills };
