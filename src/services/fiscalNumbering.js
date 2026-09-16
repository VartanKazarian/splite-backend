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

/** Qué serie tiene este restaurante, y por dónde van sus contadores. */
async function readSeries(client, restaurantId) {
  const { rows } = await client.query(
    `SELECT s.control_prefix, s.document_prefix, s.pad_to, s.control_first,
            s.control_last, s.authorisation_ref, s.updated_at,
            c.next_value AS control_next
       FROM fiscal_series s
       LEFT JOIN fiscal_counters c
         ON c.restaurant_id = s.restaurant_id AND c.scope = $2
      WHERE s.restaurant_id = $1`,
    [restaurantId, CONTROL]
  );
  return rows[0] ?? null;
}

/**
 * Guarda la serie autorizada, y deja de dejarla cambiar en cuanto ha numerado.
 *
 * Mientras no se haya emitido nada se puede escribir entera: es un formulario
 * que se rellena y se corrige. En cuanto sale el primer documento, cuatro
 * campos se congelan -- los dos prefijos, el ancho y el primer número --
 * porque cambiarlos no cambia la serie de aquí en adelante, **contradice lo ya
 * emitido**: el libro de ventas pasaría a tener dos formatos y documentos cuyo
 * número no se corresponde con la serie que dice llevarlos.
 *
 * Lo que sí sigue abierto es el tope y la referencia, que es justo lo que
 * cambia en la vida real: llega una autorización nueva que amplía el rango.
 * Bajarlo por debajo de lo ya emitido no, porque dejaría documentos fuera de su
 * propio rango.
 *
 * Una errata en el prefijo descubierta después de emitir no se arregla aquí. Ya
 * hay un documento impreso mal, y eso se resuelve con una nota de crédito, no
 * reescribiendo la serie para que el error deje de verse.
 */
async function writeSeries(client, restaurantId, next) {
  const current = await readSeries(client, restaurantId);
  const issued = current?.control_next != null;

  if (issued) {
    const frozen = [
      ['controlPrefix', 'control_prefix', next.controlPrefix, current.control_prefix],
      ['documentPrefix', 'document_prefix', next.documentPrefix, current.document_prefix],
      ['padTo', 'pad_to', next.padTo, Number(current.pad_to)],
      ['controlFirst', 'control_first', next.controlFirst, Number(current.control_first)]
    ].filter(([, , wanted, has]) => wanted !== has).map(([field]) => field);

    if (frozen.length) {
      throw new ApiError('FISCAL_SERIES_LOCKED',
        'These fields cannot change once the series has numbered a document', { fields: frozen });
    }

    const lastIssued = BigInt(current.control_next) - 1n;
    if (next.controlLast !== null && BigInt(next.controlLast) < lastIssued) {
      throw new ApiError('FISCAL_SERIES_LOCKED',
        'controlLast is below a number already issued',
        { lastIssued: lastIssued.toString() });
    }
  }

  const { rows } = await client.query(
    `INSERT INTO fiscal_series
       (restaurant_id, control_prefix, document_prefix, pad_to,
        control_first, control_last, authorisation_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (restaurant_id) DO UPDATE
       SET control_prefix = EXCLUDED.control_prefix,
           document_prefix = EXCLUDED.document_prefix,
           pad_to = EXCLUDED.pad_to,
           control_first = EXCLUDED.control_first,
           control_last = EXCLUDED.control_last,
           authorisation_ref = EXCLUDED.authorisation_ref,
           updated_at = now()
     RETURNING restaurant_id`,
    [restaurantId, next.controlPrefix, next.documentPrefix, next.padTo,
      String(next.controlFirst),
      next.controlLast === null ? null : String(next.controlLast),
      next.authorisationRef || null]
  );
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

  return readSeries(client, restaurantId);
}

module.exports = { allocate, readSeries, writeSeries, CONTROL, _internals: { format } };
