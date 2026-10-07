const crypto = require('crypto');

/**
 * El «Servicio de Notificación de Pagos» de Mercantil: un POST por cada pago
 * P2C recibido, cifrado con la llave de cada comercio.
 *
 * Según su documento («Notificación webhook cliente», vT7):
 *
 *   - El cuerpo es `{"data": "<base64>"}`, cifrado con AES y una llave derivada
 *     por SHA-256 de la «MasterKey» que el banco entrega al comercio.
 *   - La cabecera `CompIdentif` trae el RIF del comercio. Un integrador como
 *     Splite recibe las notificaciones de todos sus clientes en una sola URL y
 *     usa ese RIF para saber con qué llave descifrar.
 *   - Se responde 200 con un sobre fijo; cualquier otro estado es un fallo y el
 *     banco reintenta hasta tres veces.
 *
 * ---------------------------------------------------------------------------
 * QUÉ FALTA CONFIRMAR CON EL BANCO. El documento dice «sha256 con AES usando
 * una MasterKey» y no dice más. Lo que hace aquí es el esquema que Mercantil
 * usa en el resto de sus APIs: SHA-256 de la llave, los primeros 16 bytes como
 * llave AES-128, modo ECB con relleno PKCS#7, y base64. Si su servicio usara
 * los 32 bytes (AES-256), también se acepta: se prueba primero el de 16 y,
 * si no sale un JSON válido, el de 32. Las dos formas se confirman con el
 * primer mensaje de prueba que mande el banco con una llave de pruebas.
 * ---------------------------------------------------------------------------
 */

function derivedKeys(masterKey) {
  const digest = crypto.createHash('sha256').update(String(masterKey), 'utf8').digest();
  return [
    { algorithm: 'aes-128-ecb', key: digest.subarray(0, 16) },
    { algorithm: 'aes-256-ecb', key: digest }
  ];
}

class MercantilNotificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MercantilNotificationError';
    this.code = code;
  }
}

/** `data` → el objeto en claro. Lanza si ninguna de las dos llaves lo abre. */
function decryptNotification(data, masterKey) {
  if (typeof data !== 'string' || !data.trim()) {
    throw new MercantilNotificationError('NO_DATA', 'The notification has no data field');
  }
  const ciphertext = Buffer.from(data.trim(), 'base64');
  if (!ciphertext.length || ciphertext.length % 16 !== 0) {
    throw new MercantilNotificationError('UNDECRYPTABLE', 'The notification is not an AES block payload');
  }
  for (const { algorithm, key } of derivedKeys(masterKey)) {
    try {
      const decipher = crypto.createDecipheriv(algorithm, key, null);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plain);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // La otra longitud de llave, o nada.
    }
  }
  throw new MercantilNotificationError('UNDECRYPTABLE', 'The notification could not be decrypted with this key');
}

/**
 * Lo contrario, para las pruebas y para un simulador. Por omisión con la llave
 * de 16 bytes, que es la que se espera del banco.
 */
function encryptNotification(payload, masterKey, { bits = 128 } = {}) {
  const { algorithm, key } = derivedKeys(masterKey)[bits === 256 ? 1 : 0];
  const cipher = crypto.createCipheriv(algorithm, key, null);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

/**
 * «J-30724328-7», «J307243287» o «J000000307243287» → «J307243287».
 *
 * El documento usa las dos formas: la cabecera trae el RIF tal cual, y el
 * cuerpo lo rellena con ceros hasta quince dígitos. Se guarda y se compara sin
 * los ceros de la izquierda para que las dos lleguen a la misma conexión.
 */
function normaliseRif(raw) {
  if (raw == null) return null;
  const s = String(raw).toUpperCase().replace(/[^VEJGPC0-9]/g, '');
  const m = /^([VEJGPC])0*(\d{5,15})$/.exec(s);
  return m ? `${m[1]}${m[2]}` : null;
}

/** «20240209» o «2024-02-09», con «1400» o «14:00» → ISO en hora de Caracas. */
function occurredAt(fecha, hora) {
  const f = String(fecha ?? '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(f)) return null;
  const h = String(hora ?? '').replace(/\D/g, '');
  const hh = /^\d{4}$/.test(h) ? `${h.slice(0, 2)}:${h.slice(2)}` : '12:00';
  const iso = `${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}T${hh}:00-04:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Los códigos con que el banco da una operación por buena. */
const APPROVED = new Set(['00', '0000', '0']);
/** El bolívar, como lo escriba el banco. Un P2C en otra moneda no es un Pago Móvil. */
const BOLIVAR = new Set(['', 'VES', 'VED', 'BS', 'BSS', 'BSD', '928']);

/**
 * La notificación en claro → una fila para `bankConnections.ingest`, o el
 * motivo por el que no se registra.
 *
 * Sólo los pagos **recibidos** (`tipo` R) y aprobados: un pago enviado por el
 * restaurante, o uno rechazado, no es dinero que haya entrado.
 */
function toMovementRow(payload) {
  const n = payload && payload.webhookNotificationIn;
  if (!n || typeof n !== 'object') return { ok: false, reason: 'shape' };

  if (String(n.tipo ?? '').trim().toUpperCase() !== 'R') return { ok: false, reason: 'not_received' };
  const code = String(n.codigo ?? '').trim();
  if (code && !APPROVED.has(code)) return { ok: false, reason: 'not_approved' };
  if (!BOLIVAR.has(String(n.codigoMoneda ?? '').trim().toUpperCase())) return { ok: false, reason: 'currency' };

  const reference = String(n.referenciaBancoOrdenante || n.referenciaBancoBeneficiario || '').trim();
  const kind = String(n.tipoDatoCliente ?? '').trim().toUpperCase();
  const phone = kind === '' || kind === 'CEL' ? n.numeroProductoCliente : null;

  return {
    ok: true,
    row: {
      reference,
      amount: n.monto,
      occurredAt: occurredAt(n.fecha, n.hora),
      phoneOrigin: phone ?? null,
      idOrigin: normaliseRif(n.idCliente) ?? n.idCliente ?? null,
      bankCode: n.bancoOrdenante ?? null,
      description: n.concepto ?? null
    }
  };
}

/**
 * La respuesta que espera el banco: su `infoMsg` de vuelta y un código.
 * `codigo` 0000 es recibido; 9999, error de plataforma.
 */
function envelope(infoMsg, outcome, idRegistro = '00000') {
  const messages = {
    received: ['0000', 'Notificacion recibida con éxito!'],
    duplicate: ['0000', 'Operación duplicada'],
    rejected: ['9999', 'Otros errores']
  };
  const [codigo, mensaje] = messages[outcome] ?? messages.rejected;
  return {
    infoMsg: infoMsg && typeof infoMsg === 'object' ? infoMsg : {},
    code: 0,
    codigo,
    mensajeCliente: mensaje,
    mensajeSistema: mensaje,
    idRegistro: String(idRegistro)
  };
}

module.exports = {
  decryptNotification,
  encryptNotification,
  normaliseRif,
  toMovementRow,
  envelope,
  MercantilNotificationError,
  _internals: { occurredAt, derivedKeys }
};
