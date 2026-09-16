const { ApiError } = require('../errors');

/**
 * Los números de un documento fiscal, cuando los ponemos nosotros.
 *
 * Emitiendo por medios propios el correlativo deja de ser un dato que llega y
 * pasa a ser una responsabilidad. Dos reglas lo gobiernan, y las dos se
 * imponen aquí porque no hay nadie más que pueda imponerlas:
 *
 * **Sin repetir.** No depende de este código: hay un índice único por
 * `(restaurant_id, control_number)` y otro por `(restaurant_id, document_type,
 * document_number)`. Si algún día una carrera se colara, la base rechaza la
 * inserción en vez de dejar dos documentos con el mismo número.
 *
 * **Sin huecos.** Eso sí depende de aquí, y es lo que descarta una SEQUENCE:
 * no es transaccional, así que un ROLLBACK deja el número consumido. El libro
 * de ventas tiene que ser continuo y un número que falta es lo que se pregunta
 * en una fiscalización. Por eso el contador es una fila que se bloquea, y por
 * eso **se reparte dentro de la transacción que escribe el documento**: si esa
 * transacción no confirma, el número tampoco se gastó.
 *
 * El precio es que un restaurante no numera dos facturas a la vez. Es
 * asumible: emite unas pocas por minuto, y el bloqueo ya no abarca ninguna
 * llamada de red -- emitiendo nosotros no hay proveedor al que esperar.
 * Restaurantes distintos no se estorban, cada uno bloquea su propia fila.
 */

/** El ámbito del contador del número de control: uno solo por contribuyente. */
const CONTROL = 'CONTROL';

/**
 * Lee el contador y lo deja bloqueado, creándolo si es el primero.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` y después `SELECT ... FOR UPDATE`, en vez
 * de comprobar si existe: entre la comprobación y la inserción caben dos
 * emisiones simultáneas, y la segunda reventaría contra la clave primaria. Así
 * la que pierde la carrera simplemente no inserta y las dos se serializan en el
 * bloqueo, que es donde tienen que encontrarse.
 */
async function takeCounter(client, { restaurantId, scope, startAt }) {
  await client.query(
    `INSERT INTO fiscal_counters (restaurant_id, scope, next_value)
     VALUES ($1, $2, $3)
     ON CONFLICT (restaurant_id, scope) DO NOTHING`,
    [restaurantId, scope, String(startAt)]
  );
  const { rows } = await client.query(
    `SELECT next_value FROM fiscal_counters
      WHERE restaurant_id = $1 AND scope = $2
      FOR UPDATE`,
    [restaurantId, scope]
  );
  return BigInt(rows[0].next_value);
}

async function bumpCounter(client, { restaurantId, scope, to }) {
  await client.query(
    `UPDATE fiscal_counters SET next_value = $3, updated_at = now()
      WHERE restaurant_id = $1 AND scope = $2`,
    [restaurantId, scope, to.toString()]
  );
}

/** `12` con prefijo "00-" y ancho 8 -> "00-00000012". */
function format(prefix, value, padTo) {
  return `${prefix}${value.toString().padStart(padTo, '0')}`;
}

/**
 * Reparte el par de números para un documento nuevo.
 *
 * **Corre dentro de la transacción del llamante**, y recibe su cliente por eso:
 * el número y el documento tienen que confirmarse juntos o no confirmarse.
 *
 * Los dos contadores se bloquean **siempre en el mismo orden** -- primero el de
 * control, después el de la clase de documento -- para que dos emisiones
 * simultáneas no puedan formar un ciclo y quedarse esperándose. El orden es
 * arbitrario; lo que importa es que sea el mismo para todos.
 */
async function allocate(client, { restaurantId, documentType = 'INVOICE' }) {
  const { rows } = await client.query(
    `SELECT control_prefix, document_prefix, pad_to, control_first, control_last
       FROM fiscal_series WHERE restaurant_id = $1`,
    [restaurantId]
  );
  const series = rows[0];
  if (!series) {
    // Sin serie configurada no se puede numerar, y no se inventa un rango: los
    // números tienen que coincidir con lo que autorizó el SENIAT.
    throw new ApiError('FISCAL_SERIES_MISSING',
      'This restaurant has no authorised invoice series configured');
  }

  const control = await takeCounter(client, {
    restaurantId, scope: CONTROL, startAt: series.control_first
  });

  if (series.control_last !== null && control > BigInt(series.control_last)) {
    /*
     * El rango se acabó.
     *
     * Se rechaza en vez de seguir contando: un número de control fuera del
     * rango autorizado no es un documento con una errata, es un documento que
     * no está amparado. Quien lo vea tiene que ir a pedir un rango nuevo, y
     * para eso hace falta que esto se note.
     */
    throw new ApiError('FISCAL_RANGE_EXHAUSTED',
      'The authorised control-number range is exhausted', {
        lastAuthorised: String(series.control_last)
      });
  }

  const document = await takeCounter(client, {
    restaurantId, scope: documentType, startAt: 1
  });

  await bumpCounter(client, { restaurantId, scope: CONTROL, to: control + 1n });
  await bumpCounter(client, { restaurantId, scope: documentType, to: document + 1n });

  return {
    controlNumber: format(series.control_prefix, control, series.pad_to),
    documentNumber: format(series.document_prefix, document, series.pad_to)
  };
}

module.exports = { allocate, CONTROL, _internals: { format } };
