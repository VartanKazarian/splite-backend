const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');

/**
 * Que crear un restaurante en el fixture no pueda fallar por el RIF.
 *
 * Esto no prueba producto: prueba el andamio, y lo prueba porque el andamio ya
 * tumbó una vuelta de CI en main -- `restaurants_rif_unique_idx` con un 23505
 * dentro de un `before`, seis pruebas canceladas, y un despliegue bloqueado por
 * un fallo que no estaba en el código que se desplegaba. Un fixture que falla
 * aparece como si fallara lo que mide.
 *
 * La forma del RIF (que no dependa del reloj ni del proceso) se comprueba sin
 * base de datos en `test/fixtureRif.test.js`. Lo que hace falta la base para
 * comprobar es lo otro: que si el número sorteado ya estuviera cogido, se
 * sortea otro en vez de reventar.
 */
describe('el RIF del fixture, contra la base', { skip }, () => {
  const created = [];

  const track = async (opts) => {
    const restaurant = await fixtures.createRestaurant(opts);
    created.push(restaurant.id);
    return restaurant;
  };

  after(async () => {
    for (const id of created) await fixtures.destroyRestaurant(id);
    await db.close();
  });

  it('sortea otro cuando el primero ya está cogido', async () => {
    const taken = await track({ name: 'RIF Taken' });

    // El primer sorteo devuelve un RIF que ya existe; el segundo, uno libre.
    let draw = 0;
    const rifSource = () => (++draw === 1 ? taken.rif : `J${String(900000000 + draw)}`);

    const second = await track({ name: 'RIF Retry', rifSource });

    assert.equal(draw, 2, 'tenía que haber sorteado dos veces');
    assert.notEqual(second.rif, taken.rif);
  });

  it('no repite entre restaurantes creados a la vez', async () => {
    const many = await Promise.all(
      Array.from({ length: 20 }, (_, i) => track({ name: `RIF Concurrent ${i}` }))
    );
    assert.equal(new Set(many.map((r) => r.rif)).size, many.length);
  });
});
