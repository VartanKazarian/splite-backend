const { test } = require('node:test');
const assert = require('node:assert/strict');

const dto = require('../src/dto');
const { signQrPayload, verifyQrToken } = require('../src/utils/tokens');

/**
 * The landing a physical code leads to.
 *
 * The endpoint itself is exercised against a real database in the integration
 * suite. What is worth pinning here is the shape it returns, because it is
 * unauthenticated and reachable by anyone who can photograph a table: a field
 * added carelessly to this DTO is a field published to strangers.
 */

const TABLE = {
  id: '54b60bf1-c46d-473b-ab08-f797cbb7d458',
  name: 'Mesa 6',
  restaurant_id: '6bcd84e6-ef41-4097-97bd-8163377ad6e9',
  restaurant_name: 'La Casa del Pescador',
  menu_currency: 'VES'
};

test('the context carries what the landing needs and nothing else', () => {
  const context = dto.qrContext(TABLE, { hasOpenBill: true });

  assert.deepEqual(Object.keys(context).sort(), ['hasOpenBill', 'restaurant', 'table']);
  assert.deepEqual(Object.keys(context.restaurant).sort(), ['id', 'menuCurrency', 'name']);
  assert.deepEqual(Object.keys(context.table).sort(), ['id', 'name']);
});

test('the restaurant id is present, because the public menu is addressed by it', () => {
  // Without this the menu half of the flow cannot be reached at all: a diner
  // would have to take a session to learn which restaurant to ask about.
  assert.equal(dto.qrContext(TABLE, { hasOpenBill: false }).restaurant.id, TABLE.restaurant_id);
});

test('no amount, no payee, no bill id reaches an unauthenticated caller', () => {
  const serialised = JSON.stringify(dto.qrContext(TABLE, { hasOpenBill: true }));

  for (const leaked of ['total', 'amount', 'due', 'paid', 'payout', 'phone', 'billId', 'qr_nonce', 'nonce']) {
    assert.ok(!serialised.toLowerCase().includes(leaked.toLowerCase()),
      `${leaked} must not appear in a public QR context`);
  }
});

test('hasOpenBill is reported either way, and is only a boolean', () => {
  // It says whether to offer the bill at all -- and only what somebody standing
  // in the room can already see. The amount stays behind the session.
  assert.equal(dto.qrContext(TABLE, { hasOpenBill: true }).hasOpenBill, true);
  assert.equal(dto.qrContext(TABLE, { hasOpenBill: false }).hasOpenBill, false);
});

/**
 * The token the code carries.
 *
 * Permanence is the property the printed sticker depends on, and it is easy to
 * lose by adding a timestamp to the payload.
 */
test('a permanent code signs to the same token every time', () => {
  const payload = {
    v: 1,
    tableId: TABLE.id,
    restaurantId: TABLE.restaurant_id,
    nonce: 'd6b1f0c2-0d3f-4a34-9a2f-9f4a5f6e1b22'
  };

  // No iat, no exp: the token is a pure function of the payload and the secret.
  // With a timestamp the QR on screen would differ from the one already stuck
  // to the table, and would change on every refresh.
  assert.equal(signQrPayload(payload), signQrPayload(payload));
  assert.deepEqual(verifyQrToken(signQrPayload(payload)).nonce, payload.nonce);
});

test('rotating the nonce invalidates the printed code', () => {
  const base = { v: 1, tableId: TABLE.id, restaurantId: TABLE.restaurant_id };
  const printed = signQrPayload({ ...base, nonce: 'aaaaaaaa-0000-4000-8000-000000000001' });
  const rotated = signQrPayload({ ...base, nonce: 'bbbbbbbb-0000-4000-8000-000000000002' });

  assert.notEqual(printed, rotated);
  // Both still verify as signatures -- the nonce is checked against the table
  // row, which is what makes a reprint stop working rather than the crypto.
  assert.equal(verifyQrToken(printed).nonce, 'aaaaaaaa-0000-4000-8000-000000000001');
});
