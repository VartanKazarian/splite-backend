const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const fxService = require('../../src/services/fx');
const app = require('../../src/app');

/**
 * La tasa que acompaña a la carta pública.
 *
 * El BCV no se consulta en las pruebas, así que la tasa se sustituye: lo que
 * se prueba es lo que la ruta hace con ella -- mandarla con ocho decimales en
 * una carta en dólares, no mandarla en una en bolívares, y servir la carta
 * igual cuando no hay ninguna.
 */
describe('public menu exchange rate', { skip }, () => {
  let server;
  let base;
  let restaurant;
  const original = fxService.getRateFor;

  const menuOf = async id => {
    const res = await fetch(`${base}/api/v1/menu/public/${id}/products`);
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    restaurant = await fixtures.createRestaurant({ name: `Rate ${Date.now()}` });
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => {
    fxService.getRateFor = original;
  });

  after(async () => {
    fxService.getRateFor = original;
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  it('una carta en dólares lleva la tasa en vigor', async () => {
    await db.query("UPDATE restaurants SET menu_currency = 'USD' WHERE id = $1", [restaurant.id]);
    const asked = [];
    fxService.getRateFor = async currency => {
      asked.push(currency);
      return { rate: 757.5406, valueDate: '2026-10-01', source: 'BCV' };
    };
    const { status, body } = await menuOf(restaurant.id);
    assert.equal(status, 200);
    assert.deepEqual(asked, ['USD']);
    assert.deepEqual(body.rate, { currency: 'USD', rate: '757.54060000', valueDate: '2026-10-01' });
  });

  it('una carta en bolívares no la lleva, ni la pide', async () => {
    await db.query("UPDATE restaurants SET menu_currency = 'VES' WHERE id = $1", [restaurant.id]);
    let asked = false;
    fxService.getRateFor = async () => {
      asked = true;
      return { rate: 1 };
    };
    const { body } = await menuOf(restaurant.id);
    assert.equal(body.rate, null);
    assert.equal(asked, false);
  });

  it('sin tasa, la carta sale igual', async () => {
    await db.query("UPDATE restaurants SET menu_currency = 'EUR' WHERE id = $1", [restaurant.id]);
    fxService.getRateFor = async () => null;
    const { status, body } = await menuOf(restaurant.id);
    assert.equal(status, 200);
    assert.equal(body.rate, null);
    assert.ok(Array.isArray(body.products));
  });
});
