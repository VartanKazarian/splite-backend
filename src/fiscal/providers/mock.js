const crypto = require('crypto');
const { FiscalProviderError } = require('./index');

/**
 * Una imprenta digital simulada, cuyo trabajo principal es fallar bien.
 *
 * Existe por dos motivos y conviene no confundirlos.
 *
 * El obvio: poder desarrollar y probar el recorrido entero sin un contrato con
 * un proveedor real.
 *
 * El que importa: **reproducir la respuesta ambigua**. Un simulado que siempre
 * emite prueba el camino que nunca da problemas. El caso que hunde una
 * integración fiscal es el otro -- el proveedor contesta algo que no permite
 * saber si emitió -- y es justo el que no se puede provocar a voluntad contra
 * un servicio real. Aquí sí.
 *
 * ## Lo que este módulo NO es
 *
 * Lo que devuelve **no es una factura fiscal**. Los números que asigna son
 * inventados y llevan el prefijo `MOCK` para que nadie pueda confundirlos, ni
 * leyéndolos en una pantalla ni en una consulta a la base de datos. Un
 * documento salido de aquí no vale ante el SENIAT, no vale ante un cliente y no
 * vale ante un contador. Presentarlo como una factura de verdad sería
 * falsificar, y el prefijo está para que eso no pueda ocurrir por descuido.
 */

/**
 * Cómo se comporta, para una prueba que quiere un desenlace concreto.
 *
 * Por defecto emite: es lo que hace falta para que el resto del recorrido se
 * pueda probar sin pelear con este módulo.
 */
const BEHAVIOURS = ['ISSUE', 'REJECT', 'TIMEOUT', 'SERVER_ERROR', 'SILENT_SUCCESS', 'BAD_CONTRACT'];

function createMockProvider({ behaviour = 'ISSUE', issuedKeys = new Map() } = {}) {
  let mode = behaviour;

  const mint = (idempotencyKey) => {
    // Determinista a partir de la clave: preguntar dos veces por lo mismo tiene
    // que dar el mismo documento, que es justo lo que se está probando.
    const digest = crypto.createHash('sha256').update(idempotencyKey).digest('hex');
    return {
      outcome: 'ISSUED',
      documentNumber: `MOCK-F-${digest.slice(0, 10).toUpperCase()}`,
      controlNumber: `MOCK-CTRL-${digest.slice(10, 20).toUpperCase()}`,
      providerDocumentId: digest.slice(20, 44),
      issuedAt: new Date().toISOString()
    };
  };

  return {
    /** Cambia el comportamiento entre llamadas, para probar una secuencia. */
    __setBehaviour(next) {
      if (!BEHAVIOURS.includes(next)) throw new Error(`Comportamiento desconocido: ${next}`);
      mode = next;
    },
    __issued: issuedKeys,

    async issue(draft) {
      const key = draft?.idempotencyKey;
      if (!key) throw new FiscalProviderError('FISCAL_DRAFT_INVALID', 'Falta la clave de idempotencia', { status: 400 });

      // Ya emitida: se devuelve la misma, nunca una segunda. Es lo que hace un
      // proveedor con idempotencia de verdad, y lo que permite que reintentar
      // sea seguro cuando el proveedor la respeta.
      if (issuedKeys.has(key)) return { ...issuedKeys.get(key), replayed: true };

      switch (mode) {
        case 'REJECT':
          // Una decisión que el proveedor sí tomó. Es seguro relatarla como tal.
          throw new FiscalProviderError('FISCAL_REJECTED', 'Datos del receptor inválidos', { status: 422 });

        case 'TIMEOUT':
          throw new FiscalProviderError('FISCAL_TIMEOUT', 'Se agotó la espera', { status: 408 });

        case 'SERVER_ERROR':
          throw new FiscalProviderError('FISCAL_UPSTREAM', 'Error del proveedor', { status: 503 });

        case 'SILENT_SUCCESS': {
          /*
           * El caso que de verdad importa.
           *
           * El proveedor **emitió** y la respuesta se perdió. Desde fuera es
           * indistinguible de un fallo, y ahí está la trampa: reintentar
           * declararía la venta dos veces. La única salida correcta es
           * preguntar, y por eso el documento sí queda registrado aquí dentro
           * aunque quien llamó se lleve un error.
           */
          issuedKeys.set(key, mint(key));
          throw new FiscalProviderError('FISCAL_TIMEOUT', 'Se agotó la espera', { status: 408 });
        }

        case 'BAD_CONTRACT':
          // Un adaptador que dice haber emitido sin dar los números. El borde
          // tiene que atraparlo en vez de guardar un registro legal inservible.
          return { outcome: 'ISSUED', documentNumber: '', controlNumber: '' };

        default: {
          const issued = mint(key);
          issuedKeys.set(key, issued);
          return issued;
        }
      }
    },

    async lookup(idempotencyKey) {
      if (issuedKeys.has(idempotencyKey)) return { ...issuedKeys.get(idempotencyKey) };
      // No consta emitida. Es un hecho tan útil como el contrario: permite
      // reintentar sabiendo que no se duplica nada.
      return { outcome: 'REJECTED', reason: 'NOT_FOUND' };
    }
  };
}

module.exports = { createMockProvider, BEHAVIOURS };
