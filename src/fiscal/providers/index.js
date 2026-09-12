/**
 * La imprenta digital, detrás de una interfaz.
 *
 * En Venezuela quien asigna el número de control de una factura es una imprenta
 * digital **autorizada**, no el sistema que la pide. Eso no es un detalle de
 * integración: es la razón de que este módulo no genere números. Splite arma el
 * contenido del documento y una imprenta lo convierte en documento fiscal.
 * Inventar un número de control aquí sería falsificar.
 *
 * Por eso la interfaz tiene la forma que tiene:
 *
 *   issue(draft)    pide la emisión. Devuelve los números **que asigna el
 *                   proveedor**, o dice que no sabe si emitió.
 *   lookup(key)     pregunta por una clave de idempotencia: «¿emitiste esto?».
 *                   Es lo que convierte una respuesta ambigua en un hecho.
 *
 * `lookup` no es un extra. Es la mitad que hace segura a la otra: ante una
 * respuesta que no dice si emitió, la regla es **preguntar, nunca reintentar a
 * ciegas**. Una factura duplicada no se arregla borrando una fila -- la tabla
 * no admite DELETE, y además ya se declaró.
 */

const { logger } = require('../../connectors/logger');

/**
 * Lo que devuelve un intento, en tres formas y no en dos.
 *
 *   ISSUED       emitió, y trae los números. Un hecho.
 *   REJECTED     no emitió, y por una decisión suya. También un hecho.
 *   UNCERTAIN    no se sabe. **No es un fallo**: es la ausencia de respuesta.
 *
 * Colapsar UNCERTAIN en REJECTED es el error que cuesta dinero: se reintenta,
 * el primero sí había emitido, y el restaurante declara dos veces la misma
 * venta. Colapsarlo en ISSUED es peor todavía: se guarda un documento con
 * números que quizá no existen.
 */
const OUTCOMES = ['ISSUED', 'REJECTED', 'UNCERTAIN'];

/**
 * Estados HTTP que significan «no sabemos», no «no».
 *
 * El mismo criterio que ya usa el cliente de C2P, y por la misma razón: un
 * tiempo agotado o un 5xx puede ser una petición que el otro lado sí procesó y
 * cuya respuesta se perdió.
 */
const INDETERMINATE_HTTP = new Set([408, 425, 429]);
const isIndeterminateStatus = status =>
  INDETERMINATE_HTTP.has(status) || (status >= 500 && status <= 599);

class FiscalProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'FiscalProviderError';
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Comprueba que un adaptador cumple lo que se le va a pedir.
 *
 * Al registrarlo y no en la primera factura: un adaptador a medio escribir
 * tiene que impedir arrancar, no fallar delante de un comensal que espera.
 */
function assertAdapter(adapter, name) {
  for (const method of ['issue', 'lookup']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new Error(`El proveedor fiscal "${name}" no implementa ${method}()`);
    }
  }
  return adapter;
}

const registry = new Map();

function register(name, adapter) {
  registry.set(name, assertAdapter(adapter, name));
}

/**
 * El adaptador de un proveedor, o un error que nombra los que sí hay.
 *
 * Nunca devuelve uno por defecto. Caer en un simulado porque el nombre no
 * coincide produciría documentos de mentira con toda la apariencia de buenos,
 * que es exactamente lo que no puede pasar.
 */
function adapterFor(name) {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new FiscalProviderError(
      'FISCAL_PROVIDER_UNKNOWN',
      `No hay adaptador fiscal para "${name}"`,
      { known: [...registry.keys()] }
    );
  }
  return adapter;
}

/**
 * Pide la emisión y devuelve siempre uno de los tres desenlaces.
 *
 * Envuelve al adaptador para que **ninguna** excepción inesperada se lea como
 * un rechazo. Un fallo de red, un JSON roto o un error de programación en el
 * adaptador significan lo mismo desde aquí: no sabemos si emitió.
 */
async function issue(providerName, draft) {
  const adapter = adapterFor(providerName);
  try {
    const result = await adapter.issue(draft);
    if (!OUTCOMES.includes(result?.outcome)) {
      // Un adaptador que contesta cualquier otra cosa no puede tratarse como un
      // rechazo: quizá emitió y lo dijo mal.
      logger.error({
        event: 'FISCAL_ADAPTER_BAD_OUTCOME', provider: providerName, outcome: result?.outcome
      }, 'El adaptador fiscal devolvió un desenlace desconocido');
      return { outcome: 'UNCERTAIN', reason: 'ADAPTER_BAD_OUTCOME' };
    }
    if (result.outcome === 'ISSUED') assertIssued(result, providerName);
    return result;
  } catch (err) {
    const indeterminate = err?.status === undefined || isIndeterminateStatus(err.status);
    logger.warn({
      event: 'FISCAL_ISSUE_FAILED', provider: providerName,
      code: err?.code, status: err?.status, indeterminate
    }, 'Fallo al pedir la emisión de una factura');

    if (!indeterminate) {
      return { outcome: 'REJECTED', reason: err?.code ?? 'PROVIDER_REJECTED' };
    }
    return { outcome: 'UNCERTAIN', reason: err?.code ?? 'PROVIDER_UNREACHABLE' };
  }
}

/**
 * Un ISSUED sin números no es un ISSUED.
 *
 * Se comprueba aquí, en el borde, y no se confía en el adaptador: guardar una
 * factura con el número de control vacío deja un registro legal inservible en
 * una tabla que no admite UPDATE.
 */
function assertIssued(result, providerName) {
  for (const field of ['documentNumber', 'controlNumber']) {
    if (!result[field] || String(result[field]).trim() === '') {
      throw new FiscalProviderError(
        'FISCAL_PROVIDER_CONTRACT',
        `El proveedor "${providerName}" dijo ISSUED sin ${field}`,
        { status: 502 }
      );
    }
  }
}

/**
 * Pregunta si una clave de idempotencia ya produjo un documento.
 *
 * El camino de salida de UNCERTAIN. Si tampoco se puede preguntar, el desenlace
 * sigue siendo UNCERTAIN y el caso va a la cola de una persona -- que es el
 * final correcto, no un fallo: alguien tiene que mirar antes de declarar dos
 * veces.
 */
async function lookup(providerName, idempotencyKey) {
  const adapter = adapterFor(providerName);
  try {
    const result = await adapter.lookup(idempotencyKey);
    if (result?.outcome === 'ISSUED') assertIssued(result, providerName);
    if (!OUTCOMES.includes(result?.outcome)) return { outcome: 'UNCERTAIN', reason: 'ADAPTER_BAD_OUTCOME' };
    return result;
  } catch (err) {
    logger.warn({
      event: 'FISCAL_LOOKUP_FAILED', provider: providerName, code: err?.code, status: err?.status
    }, 'No se pudo preguntar por una factura en duda');
    return { outcome: 'UNCERTAIN', reason: err?.code ?? 'LOOKUP_UNAVAILABLE' };
  }
}

module.exports = {
  OUTCOMES, FiscalProviderError, isIndeterminateStatus,
  register, adapterFor, issue, lookup, assertAdapter,
  __registry: registry
};
