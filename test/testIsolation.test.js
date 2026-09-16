const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, 'integration');
const files = fs.readdirSync(DIR).filter(f => f.endsWith('.js'));

/**
 * Lo que una prueba no puede hacerle al resto.
 *
 * El runner corre los ficheros **en paralelo** contra la misma base, así que
 * una prueba que cambia algo global se lo cambia a las demás mientras corren.
 * Eso no se manifiesta como un fallo en quien lo hace: falla otro fichero, en
 * una vuelta de cada tantas, y parece un flake.
 *
 * Pasó de verdad. Cinco ficheros apagaban la inmutabilidad de los documentos
 * fiscales con `ALTER TABLE ... DISABLE TRIGGER` para poder limpiar. Eso es
 * global y no de la sesión -- comprobado: apagarlo en una conexión deja
 * `pg_trigger.tgenabled` en 'D' para cualquier otra --, así que mientras un
 * teardown lo tenía apagado, `fiscalSchema` comprobaba que una factura emitida
 * no se puede modificar, veía pasar su UPDATE y fallaba con *Missing expected
 * rejection*, sin que nada suyo hubiera cambiado.
 *
 * `fixtures.purgeFiscal` hace lo mismo con `session_replication_role`, que sólo
 * afecta a su propia sesión. Esta prueba existe para que nadie vuelva a la
 * forma global sin enterarse: es estática y no necesita base, así que avisa en
 * el sitio barato en vez de en una vuelta roja de CI dentro de tres semanas.
 */
test('ninguna prueba apaga un trigger para todas las demás', () => {
  const offenders = [];

  for (const file of files) {
    const body = fs.readFileSync(path.join(DIR, file), 'utf8')
      .split('\n')
      // Los comentarios describen; sólo el código hace algo. El propio helper
      // nombra la forma prohibida para explicar por qué no se usa.
      .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n');

    if (/ALTER\s+TABLE[^;'`]*\b(DISABLE|ENABLE)\s+TRIGGER\b/i.test(body)) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, [], [
    'Estos ficheros apagan un trigger a lo ancho de toda la base:',
    ...offenders.map(f => `  - ${f}`),
    '',
    'El runner corre los ficheros en paralelo, así que mientras esto esté',
    'apagado lo está para todos, y el que compruebe ese trigger fallará sin',
    'haber cambiado nada. Usa `fixtures.purgeFiscal`, que lo hace sólo en su',
    'sesión con session_replication_role.'
  ].join('\n'));
});
