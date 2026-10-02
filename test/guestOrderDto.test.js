const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const dto = require('../src/dto');

/**
 * Lo que la bandeja del personal recibe de un pedido desde la mesa.
 *
 * La moneda viaja porque los importes de las líneas están en la de la cuenta:
 * una carta en dólares deja las líneas en dólares, y la bandeja los pintaba
 * como bolívares.
 */
describe('guestOrder dto', () => {
  const row = {
    id: 'o1', table_id: 't1', table_name: 'Mesa 7', bill_id: 'b1', served_by: null,
    line_count: 1, created_at: new Date().toISOString(),
    items: [{ name: 'Tequeños', quantity: 2, subtotalMinor: 1600 }]
  };

  it('lleva la moneda de la cuenta', () => {
    assert.equal(dto.guestOrder({ ...row, currency: 'USD' }).currency, 'USD');
    assert.equal(dto.guestOrder({ ...row, currency: 'VES' }).currency, 'VES');
  });

  it('sin cuenta, la moneda es null y no se inventa', () => {
    assert.equal(dto.guestOrder({ ...row, bill_id: null, currency: null }).currency, null);
  });

  it('lleva la nota tal cual, o null', () => {
    assert.equal(dto.guestOrder({ ...row, note: 'sin cebolla' }).note, 'sin cebolla');
    assert.equal(dto.guestOrder(row).note, null);
  });

  it('los importes salen como texto', () => {
    assert.equal(dto.guestOrder(row).items[0].subtotalMinor, '1600');
  });
});
