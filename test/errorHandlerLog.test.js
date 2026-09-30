const test = require('node:test');
const assert = require('node:assert/strict');

const { logger } = require('../src/connectors/logger');
const { ApiError } = require('../src/errors');
const errorHandler = require('../src/middleware/errorHandler');

/**
 * Qué deja el manejador de errores en el registro.
 *
 * Un 4xx deliberado es rutina y no necesita su traza; un fallo del servidor
 * sí. Y la ruta se registra sin la cadena de consulta.
 */
function capture(fn) {
  const seen = [];
  const original = { warn: logger.warn, error: logger.error };
  logger.warn = (obj, msg) => seen.push({ level: 'warn', obj, msg });
  logger.error = (obj, msg) => seen.push({ level: 'error', obj, msg });
  try { fn(); } finally { Object.assign(logger, original); }
  return seen;
}
const res = () => ({ headersSent: false, status() { return this; }, json() { return this; } });
const req = { method: 'GET', baseUrl: '/api/v1/payments', path: '/claims', originalUrl: '/api/v1/payments/claims?to=2026-09-01', id: 'r1' };

test('un 4xx deliberado se registra sin traza y sin la consulta', () => {
  const [entry] = capture(() => errorHandler(new ApiError('NOT_FOUND', 'Not found'), req, res(), () => {}));
  assert.equal(entry.level, 'warn');
  assert.equal(entry.obj.err, undefined);
  assert.equal(entry.obj.path, '/api/v1/payments/claims');
  assert.equal(entry.obj.code, 'NOT_FOUND');
});

test('un error inesperado se registra entero, con su traza', () => {
  const boom = new Error('connection terminated');
  const [entry] = capture(() => errorHandler(boom, req, res(), () => {}));
  assert.equal(entry.level, 'error');
  assert.equal(entry.obj.err, boom);
});
