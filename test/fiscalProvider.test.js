const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../src/fiscal/providers');
const { createMockProvider } = require('../src/fiscal/providers/mock');

/**
 * El borde con la imprenta digital.
 *
 * Casi todo lo que se afirma aquí es sobre **no saber**. Emitir bien es el
 * camino fácil; el que hunde una integración fiscal es aquel en el que el
 * proveedor contesta algo que no dice si emitió, porque las dos salidas
 * evidentes están mal: reintentar declara la venta dos veces, y darlo por
 * fallido deja al comensal sin su factura y al restaurante con una venta sin
 * documentar.
 */

const NAME = 'mock-test';
let mock;

beforeEach(() => {
  mock = createMockProvider();
  providers.register(NAME, mock);
});

const draft = (key = 'k-1') => ({ idempotencyKey: key, totalMinor: 1160n });

/* ------------------------------------------------------------- lo que sí es */

test('una emisión buena trae los dos números, y los pone el proveedor', () => {
  return providers.issue(NAME, draft()).then(result => {
    assert.equal(result.outcome, 'ISSUED');
    assert.ok(result.documentNumber, 'sin número de documento no hay factura');
    assert.ok(result.controlNumber, 'ni sin número de control');
  });
});

test('los números del simulado se identifican como falsos a simple vista', async () => {
  /*
   * El prefijo no es cosmético.
   *
   * Un documento salido del simulado no vale ante el SENIAT ni ante nadie.
   * Tiene que ser imposible confundirlo con uno real -- leyéndolo en una
   * pantalla o en una consulta a la base -- para que no acabe presentado como
   * una factura de verdad por descuido.
   */
  const result = await providers.issue(NAME, draft());
  assert.match(result.documentNumber, /^MOCK-/);
  assert.match(result.controlNumber, /^MOCK-/);
});

test('un rechazo del proveedor se relata como rechazo: es una decisión suya', async () => {
  mock.__setBehaviour('REJECT');
  const result = await providers.issue(NAME, draft());
  assert.equal(result.outcome, 'REJECTED', 'un 422 es un «no», no un «no sé»');
});

/* -------------------------------------------------------- lo que no se sabe */

test('un tiempo agotado no es un rechazo', async () => {
  // Leerlo como rechazo llevaría a reintentar. Si el primero sí emitió, el
  // restaurante acaba declarando dos veces la misma venta.
  mock.__setBehaviour('TIMEOUT');
  const result = await providers.issue(NAME, draft());
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.notEqual(result.outcome, 'REJECTED');
});

test('un 5xx tampoco: puede haber emitido y perdido la respuesta', async () => {
  mock.__setBehaviour('SERVER_ERROR');
  assert.equal((await providers.issue(NAME, draft())).outcome, 'UNCERTAIN');
});

test('preguntar convierte una respuesta ambigua en un hecho', async () => {
  /*
   * El caso entero, de principio a fin.
   *
   * El proveedor emite y la respuesta se pierde. Quien llamó se lleva un error
   * indistinguible de un fallo. La salida no es reintentar: es preguntar por la
   * clave de idempotencia, y ahí aparece el documento que sí existe.
   */
  mock.__setBehaviour('SILENT_SUCCESS');
  const attempt = await providers.issue(NAME, draft('k-perdida'));
  assert.equal(attempt.outcome, 'UNCERTAIN', 'desde fuera parece un fallo');

  const asked = await providers.lookup(NAME, 'k-perdida');
  assert.equal(asked.outcome, 'ISSUED', 'pero sí había emitido');
  assert.ok(asked.controlNumber);
});

test('preguntar por algo que no se emitió lo dice, y eso permite reintentar', async () => {
  mock.__setBehaviour('SERVER_ERROR');
  await providers.issue(NAME, draft('k-limpia'));

  const asked = await providers.lookup(NAME, 'k-limpia');
  assert.equal(asked.outcome, 'REJECTED', 'no consta: reintentar no duplica nada');
});

test('si no se puede ni preguntar, sigue sin saberse -- y eso es correcto', async () => {
  // El final honesto es la cola de una persona. Inventar un desenlace para no
  // dejar nada pendiente es exactamente lo que no se puede hacer.
  providers.register('caido', {
    issue: async () => { throw new Error('sin red'); },
    lookup: async () => { throw new Error('sin red'); }
  });
  assert.equal((await providers.lookup('caido', 'k')).outcome, 'UNCERTAIN');
});

test('la misma clave no emite dos veces, y devuelve el mismo documento', async () => {
  const first = await providers.issue(NAME, draft('k-repe'));
  const second = await providers.issue(NAME, draft('k-repe'));

  assert.equal(second.outcome, 'ISSUED');
  assert.equal(second.controlNumber, first.controlNumber, 'el mismo documento, no uno nuevo');
  assert.equal(second.replayed, true);
});

/* ----------------------------------------------------- el borde desconfiado */

test('un ISSUED sin números no se acepta como emitido', async () => {
  /*
   * Guardar una factura con el número de control vacío dejaría un registro
   * legal inservible en una tabla que no admite UPDATE: no habría forma de
   * arreglarlo después. Se comprueba en el borde y no se confía en el adaptador.
   */
  mock.__setBehaviour('BAD_CONTRACT');
  const result = await providers.issue(NAME, draft());
  assert.notEqual(result.outcome, 'ISSUED');
  assert.equal(result.outcome, 'UNCERTAIN', 'y en duda, no rechazado: quizá sí emitió');
});

test('un desenlace que no es ninguno de los tres se trata como duda', async () => {
  providers.register('raro', {
    issue: async () => ({ outcome: 'QUIZAS' }),
    lookup: async () => ({ outcome: 'QUIZAS' })
  });
  assert.equal((await providers.issue('raro', draft())).outcome, 'UNCERTAIN');
  assert.equal((await providers.lookup('raro', 'k')).outcome, 'UNCERTAIN');
});

test('una excepción inesperada del adaptador es duda, no rechazo', async () => {
  // Un error de programación en el adaptador no puede leerse como «el proveedor
  // dijo que no»: no dijo nada.
  providers.register('roto', {
    issue: async () => { throw new TypeError('undefined is not a function'); },
    lookup: async () => ({ outcome: 'REJECTED' })
  });
  assert.equal((await providers.issue('roto', draft())).outcome, 'UNCERTAIN');
});

/* ---------------------------------------------------------------- registro */

test('un proveedor desconocido revienta en vez de caer en el simulado', async () => {
  // Caer en el simulado produciría documentos de mentira con toda la apariencia
  // de buenos. Es el fallo más caro posible en este módulo.
  await assert.rejects(() => providers.issue('no-existe', draft()), err => {
    assert.equal(err.code, 'FISCAL_PROVIDER_UNKNOWN');
    return true;
  });
});

test('un adaptador a medio escribir no se puede registrar', () => {
  // Al registrarlo y no en la primera factura: tiene que impedir arrancar, no
  // fallar delante de un comensal que espera.
  assert.throws(() => providers.register('medias', { issue: async () => ({}) }), /lookup/);
  assert.throws(() => providers.register('nada', {}), /issue/);
});

test('sólo un 4xx deliberado cuenta como decisión del proveedor', () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    assert.equal(providers.isIndeterminateStatus(status), false, `${status} es un no`);
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(providers.isIndeterminateStatus(status), true, `${status} es un no sé`);
  }
});
