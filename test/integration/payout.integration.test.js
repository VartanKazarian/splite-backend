const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const app = require('../../src/app');
const { signAccessToken } = require('../../src/utils/tokens');

/**
 * Payee configuration, and the line between what staff see and what a diner
 * does.
 */
describe('restaurant payout details', { skip }, () => {
  let server;
  let baseUrl;
  let restaurant;
  let ownerToken;
  let waiterToken;

  const PAYOUT = {
    bankCode: '0105',
    accountNumber: '01050000000000000001',
    phone: '0412-123.45.67',
    holderId: 'J123456789'
  };

  before(async () => {
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    restaurant = await fixtures.createRestaurant({ name: `Payout ${Date.now()}` });

    const mint = role => signAccessToken({
      id: `00000000-0000-4000-8000-0000000000${role === 'OWNER' ? '01' : '02'}`,
      restaurantId: restaurant.id,
      role
    });
    ownerToken = mint('OWNER');
    waiterToken = mint('WAITER');
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await fixtures.destroyRestaurant(restaurant?.id);
    await db.close();
    await closeRedis();
  });

  const call = async (method, path, token, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  it('stores the payee and normalises the phone to digits', async () => {
    const res = await call('PUT', '/api/v1/account/payout', ownerToken, PAYOUT);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.body.payout.bankCode, '0105');
    assert.equal(res.body.payout.bankName, 'Mercantil');
    assert.equal(res.body.payout.phone, '04121234567', 'one number written three ways is one value');
    // Honest about what we can actually do with it.
    assert.equal(res.body.payout.chargeable, false);
  });

  it('refuses an account number from a different bank', async () => {
    const res = await call('PUT', '/api/v1/account/payout', ownerToken, {
      ...PAYOUT, bankCode: '0134'
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION_FAILED');
  });

  it('will not let a waiter change where the money goes', async () => {
    const res = await call('PUT', '/api/v1/account/payout', waiterToken, PAYOUT);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'FORBIDDEN_ROLE');
  });

  it('withholds the account number from the diner', async () => {
    // A Pago Móvil is addressed by bank, phone and identity document. The
    // account number is not needed for it, and anyone who scans a sticker on a
    // table can reach the guest surface.
    await call('PUT', '/api/v1/account/payout', ownerToken, PAYOUT);

    const { rows } = await db.query(
      `SELECT payout_bank_code, payout_phone, payout_holder_id, payout_account_number
         FROM restaurants WHERE id = $1`,
      [restaurant.id]
    );
    const dto = require('../../src/dto');
    const payee = dto.guestPayee(rows[0]);

    assert.equal(payee.bankCode, '0105');
    assert.equal(payee.phone, '04121234567');
    assert.equal(payee.holderId, 'J123456789');
    assert.equal(payee.accountNumber, undefined, 'the account number must not reach a diner');
    assert.ok(!JSON.stringify(payee).includes(PAYOUT.accountNumber));
  });

  it('clears the payee with an empty body', async () => {
    await call('PUT', '/api/v1/account/payout', ownerToken, PAYOUT);
    const cleared = await call('PUT', '/api/v1/account/payout', ownerToken, {});
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.payout, null);
  });

  it('cannot be left half configured, even going around the schema', async () => {
    // The database is the guarantee; the schema is the error message.
    await assert.rejects(
      () => db.query(
        'UPDATE restaurants SET payout_bank_code = $2, payout_account_number = NULL WHERE id = $1',
        [restaurant.id, '0105']
      ),
      err => {
        assert.equal(err.code, '23514');
        assert.match(err.constraint, /payout_complete/);
        return true;
      }
    );
  });

  it('lists banks with their integration status', async () => {
    const res = await call('GET', '/api/v1/account/banks', ownerToken);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 10);
    assert.ok(res.body.data.every(b => /^0[0-9]{3}$/.test(b.code)));
    assert.ok(res.body.data.every(b => b.chargeable === false), 'no bank has a module yet');
  });
});
