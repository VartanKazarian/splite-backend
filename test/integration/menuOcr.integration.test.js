const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const fixtures = require('./helpers/fixtures');
const { extractMenu } = require('../../src/services/menuOcr');

/**
 * The parts of the menu import that only a real Postgres can settle: that one
 * duplicate name does not discard the rest of the import, and that the rows
 * land with the restaurant's own currency.
 *
 * The route's insert loop is reproduced here rather than driven over HTTP,
 * because what is under test is the savepoint behaviour -- and the reason it is
 * needed is a Postgres rule, not an Express one.
 */
describe('menu OCR import against a real Postgres', { skip }, () => {
  let restaurant;

  before(async () => { restaurant = await fixtures.createRestaurant(); });
  after(async () => {
    await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [restaurant?.id]);
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
  });

  /** Exactly the loop in POST /menu/ocr-import. */
  const importItems = (items, currency = 'VES') => db.withTransaction(async client => {
    const imported = [];
    const errors = [];
    for (const [index, item] of items.entries()) {
      await client.query('SAVEPOINT item');
      try {
        const { rows } = await client.query(
          `INSERT INTO menu_products (restaurant_id, name, description, price_minor_units, currency, active)
           VALUES ($1,$2,$3,$4,$5,true) RETURNING id, name, price_minor_units, currency`,
          [restaurant.id, item.name, item.description || null, item.priceMinorUnits, currency]
        );
        await client.query('RELEASE SAVEPOINT item');
        imported.push(rows[0]);
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT item');
        if (err.code === '23505') errors.push({ index, name: item.name, code: 'PRODUCT_NAME_TAKEN' });
        else throw err;
      }
    }
    return { imported, errors };
  });

  it('imports a reviewed batch in the restaurant currency', async () => {
    const { imported, errors } = await importItems([
      { name: 'Pasta Boloñesa', priceMinorUnits: '2500' },
      { name: 'Cerveza Polar', priceMinorUnits: '850', description: 'Tercio' }
    ]);

    assert.equal(imported.length, 2);
    assert.deepEqual(errors, []);
    assert.equal(imported[0].price_minor_units, '2500');
    assert.equal(imported[0].currency, 'VES', 'the restaurant setting, not the request');
  });

  it('a duplicate name rejects that row and keeps the rest', async () => {
    // The savepoint is the whole point. Without it the first 23505 aborts the
    // transaction and every later insert fails with 25P02 -- so a plain
    // try/catch would import nothing and report one error.
    await importItems([{ name: 'Arepa Reina', priceMinorUnits: '1200' }]);

    const { imported, errors } = await importItems([
      { name: 'Tequeños', priceMinorUnits: '900' },
      { name: 'Arepa Reina', priceMinorUnits: '1300' },   // already on the menu
      { name: 'Empanada', priceMinorUnits: '700' }
    ]);

    assert.equal(imported.length, 2, 'the rows after the duplicate still import');
    assert.deepEqual(imported.map(i => i.name).sort(), ['Empanada', 'Tequeños']);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].index, 1, 'reported by its position in the request');
    assert.equal(errors[0].code, 'PRODUCT_NAME_TAKEN');

    // The original keeps its price: a duplicate is refused, never an update.
    const { rows } = await db.query(
      'SELECT price_minor_units FROM menu_products WHERE restaurant_id = $1 AND name = $2',
      [restaurant.id, 'Arepa Reina']
    );
    assert.equal(rows[0].price_minor_units, '1200');
  });

  it('a name taken in another restaurant does not collide', async () => {
    // menu_products is unique on (restaurant_id, name), so two restaurants may
    // both sell an Arepa Reina.
    const other = await fixtures.createRestaurant({ name: 'Otro' });
    try {
      const { rows } = await db.query(
        `INSERT INTO menu_products (restaurant_id, name, price_minor_units, currency, active)
         VALUES ($1,'Arepa Reina',1500,'VES',true) RETURNING id`,
        [other.id]
      );
      assert.ok(rows[0].id);
    } finally {
      await db.query('DELETE FROM menu_products WHERE restaurant_id = $1', [other.id]);
      await fixtures.destroyRestaurant(other.id);
    }
  });

  it('rasterises a PDF upload into page images', async () => {
    // A one-page PDF built by hand, so the test needs no fixture binary. Proves
    // the pdftoppm path end to end; the model itself is stubbed, since what is
    // under test is that a PDF becomes images at all.
    const pdf = Buffer.from(
      '%PDF-1.4\n' +
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 20 100 Td (Pasta 25,00) Tj ET\nendstream endobj\n' +
      'trailer<</Root 1 0 R>>\n', 'latin1');

    let sawImages = null;
    const result = await extractMenu({
      buffer: pdf,
      contentType: 'application/pdf',
      currency: 'VES',
      visionClient: async images => {
        sawImages = images;
        return { items: [{ name: 'Pasta', priceText: '25,00' }], currencyGuess: 'VES' };
      }
    });

    assert.ok(sawImages && sawImages.length >= 1, 'the PDF reached the model as page images');
    assert.equal(sawImages[0].mediaType, 'image/png');
    assert.ok(sawImages[0].base64.length > 0);
    assert.equal(result.pages, sawImages.length);
    assert.equal(result.items[0].priceMinorUnits, '2500');
  });

  it('refuses a file type the reader cannot open', async () => {
    await assert.rejects(
      () => extractMenu({
        buffer: Buffer.from('not a menu'),
        contentType: 'text/csv',
        currency: 'VES',
        visionClient: async () => ({ items: [] })
      }),
      err => err.code === 'MENU_OCR_UNSUPPORTED_MEDIA' && err.statusCode === 400
    );
  });
});
