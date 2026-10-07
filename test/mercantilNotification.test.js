const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  decryptNotification, encryptNotification, normaliseRif, toMovementRow, envelope, MercantilNotificationError,
  _internals: { occurredAt }
} = require('../src/payments/providers/mercantil/notification');

/**
 * Las notificaciones de pago de Mercantil (documento vT7).
 *
 * Lo que importa: que sólo una llave buena abra un mensaje, que sólo un pago
 * recibido y aprobado en bolívares se convierta en un movimiento, y que el RIF
 * de la cabecera y el del cuerpo -- escritos distinto -- sean el mismo.
 */
const KEY = 'llave-de-pruebas-del-comercio';

/** El mensaje en claro del documento del banco, con los datos de un pago real. */
function sample(over = {}) {
  return {
    infoMsg: {
      guId: 'ad2a1719-f8af-10d1-60e7-d4e5d5b93464', channel: '0006', subchannel: '07',
      applId: 'OLB', personId: 'V11312786@J306993762', userId: '', token: '', action: ''
    },
    webhookNotificationIn: {
      codigo: '00', mensajeCliente: 'Aprobada', mensajeSistema: 'Aprobada',
      referenciaBancoOrdenante: '000123456789', referenciaBancoBeneficiario: '987654',
      tipo: 'R', bancoOrdenante: '0102', bancoBeneficiario: '0105',
      idCliente: 'V000000010824244', tipoDatoCliente: 'CEL', numeroProductoCliente: '00584141234567',
      idComercio: 'J000000406848786', tipoDatoComercio: 'CEL', numeroProductoComercio: '00584241234567',
      fecha: '20240209', hora: '1400', codigoMoneda: 'VES', monto: '1234.50',
      numeroFactura: '0', numeroContrato: '0', concepto: 'Mesa 7',
      ...over
    }
  };
}

describe('notificaciones de Mercantil', () => {
  it('cifrar y descifrar con la misma llave devuelve el mensaje', () => {
    const payload = sample();
    assert.deepEqual(decryptNotification(encryptNotification(payload, KEY), KEY), payload);
  });

  it('es AES-128-ECB con los primeros 16 bytes del SHA-256 de la llave, en base64', () => {
    const payload = { hola: 'mundo' };
    const key = crypto.createHash('sha256').update(KEY).digest().subarray(0, 16);
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    const data = Buffer.concat([c.update(JSON.stringify(payload)), c.final()]).toString('base64');
    assert.equal(encryptNotification(payload, KEY), data);
    assert.deepEqual(decryptNotification(data, KEY), payload);
  });

  it('también abre un mensaje cifrado con los 32 bytes (AES-256), por si el banco usa esa variante', () => {
    const payload = sample();
    assert.deepEqual(decryptNotification(encryptNotification(payload, KEY, { bits: 256 }), KEY), payload);
  });

  it('otra llave no abre el mensaje', () => {
    const data = encryptNotification(sample(), KEY);
    assert.throws(() => decryptNotification(data, 'otra-llave-cualquiera'),
      e => e instanceof MercantilNotificationError && e.code === 'UNDECRYPTABLE');
  });

  it('sin data, o con algo que no son bloques AES, se rechaza sin intentar', () => {
    for (const data of [undefined, null, '', '   ', 42]) {
      assert.throws(() => decryptNotification(data, KEY), e => e.code === 'NO_DATA');
    }
    assert.throws(() => decryptNotification(Buffer.from('corto').toString('base64'), KEY), e => e.code === 'UNDECRYPTABLE');
  });

  it('un bloque que se descifra pero no es JSON no se acepta', () => {
    const key = crypto.createHash('sha256').update(KEY).digest().subarray(0, 16);
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    const data = Buffer.concat([c.update('esto no es json'), c.final()]).toString('base64');
    assert.throws(() => decryptNotification(data, KEY), e => e.code === 'UNDECRYPTABLE');
  });

  it('el RIF de la cabecera y el del cuerpo, escritos distinto, son el mismo', () => {
    assert.equal(normaliseRif('J307243287'), 'J307243287');
    assert.equal(normaliseRif('J-30724328-7'), 'J307243287');
    assert.equal(normaliseRif('j000000307243287'), 'J307243287');
    assert.equal(normaliseRif(' V-12.345.678 '), 'V12345678');
    for (const bad of [null, undefined, '', '307243287', 'X307243287', 'J12', 'J1234567890123456']) {
      assert.equal(normaliseRif(bad), null, String(bad));
    }
  });

  it('un pago recibido y aprobado se convierte en un movimiento', () => {
    const r = toMovementRow(sample());
    assert.equal(r.ok, true);
    assert.deepEqual(r.row, {
      reference: '000123456789',
      amount: '1234.50',
      occurredAt: '2024-02-09T18:00:00.000Z',
      phoneOrigin: '00584141234567',
      idOrigin: 'V10824244',
      bankCode: '0102',
      description: 'Mesa 7'
    });
  });

  it('sin la referencia del ordenante, la del beneficiario', () => {
    assert.equal(toMovementRow(sample({ referenciaBancoOrdenante: '' })).row.reference, '987654');
  });

  it('el teléfono sólo si lo que identifica al pagador es un celular', () => {
    assert.equal(toMovementRow(sample({ tipoDatoCliente: 'EMAIL', numeroProductoCliente: 'a@b.com' })).row.phoneOrigin, null);
    assert.equal(toMovementRow(sample({ tipoDatoCliente: '' })).row.phoneOrigin, '00584141234567');
  });

  it('un pago enviado, rechazado o en otra moneda no es dinero que entró', () => {
    assert.deepEqual(toMovementRow(sample({ tipo: 'E' })), { ok: false, reason: 'not_received' });
    assert.deepEqual(toMovementRow(sample({ codigo: '51' })), { ok: false, reason: 'not_approved' });
    assert.deepEqual(toMovementRow(sample({ codigoMoneda: 'USD' })), { ok: false, reason: 'currency' });
    assert.deepEqual(toMovementRow({ infoMsg: {} }), { ok: false, reason: 'shape' });
    assert.deepEqual(toMovementRow(null), { ok: false, reason: 'shape' });
  });

  it('los códigos de aprobación y las formas del bolívar que se aceptan', () => {
    for (const codigo of ['00', '0000', '0', '', undefined]) {
      assert.equal(toMovementRow(sample({ codigo })).ok, true, String(codigo));
    }
    for (const codigoMoneda of ['VES', 'ves', 'VED', 'Bs', '928', '', undefined]) {
      assert.equal(toMovementRow(sample({ codigoMoneda })).ok, true, String(codigoMoneda));
    }
  });

  it('la fecha y la hora, en las dos formas del documento, en hora de Caracas', () => {
    assert.equal(occurredAt('20240209', '1400'), '2024-02-09T18:00:00.000Z');
    assert.equal(occurredAt('2024-02-09', '14:00'), '2024-02-09T18:00:00.000Z');
    assert.equal(occurredAt('20240209', ''), '2024-02-09T16:00:00.000Z');
    assert.equal(occurredAt('', '1400'), null);
    assert.equal(occurredAt('2024021', '1400'), null);
  });

  it('el sobre de respuesta devuelve el infoMsg del banco y el código de cada caso', () => {
    const info = sample().infoMsg;
    const ok = envelope(info, 'received');
    assert.deepEqual(ok, {
      infoMsg: info, code: 0, codigo: '0000',
      mensajeCliente: 'Notificacion recibida con éxito!', mensajeSistema: 'Notificacion recibida con éxito!',
      idRegistro: '00000'
    });
    assert.equal(envelope(info, 'duplicate').mensajeCliente, 'Operación duplicada');
    assert.equal(envelope(info, 'duplicate').codigo, '0000');
    assert.equal(envelope(info, 'rejected').codigo, '9999');
    assert.equal(envelope(null, 'cualquier-cosa').codigo, '9999');
    assert.deepEqual(envelope('no-es-objeto', 'received').infoMsg, {});
  });
});
