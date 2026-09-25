const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const claims = require('../../src/services/paymentClaims');
const { signatureFor } = require('../../src/services/bankConnections');
const app = require('../../src/app');

/**
 * Conexiones con el banco, sobre HTTP.
 *
 * Esto puede dar por cobrado un dinero sin que lo mire nadie, así que casi
 * todo lo de aquí son formas de que NO lo haga: una firma mala, una petición
 * vieja, una conexión de otro restaurante, dos avisos con la misma referencia,
 * una conexión en la que el dueño todavía no confía.
 */
describe('conexiones con el banco', { skip }, () => {
  let server, base, restaurant, other, ownerToken, cashierToken, waiterToken, otherOwnerToken, seq = 0;

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1', 'bank-inbound:::ffff:127.0.0.1', 'bank-inbound:127.0.0.1'
  );
  beforeEach(clearIpRateLimits);

  const mint = async (tenant, role) => {
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role)
       VALUES ($1, $2, 'x', $3) RETURNING id`,
      [tenant.id, `${role.toLowerCase()}-${++seq}-${tenant.id}@example.com`, role]
    );
    return signAccessToken({ id: rows[0].id, restaurantId: tenant.id, role });
  };

  const call = async (method, path, { body, token, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body || raw ? { 'content-type': 'application/json' } : {}),
        ...headers
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  /** Un POST firmado como lo haría un sistema externo. */
  const push = (connectionId, secret, movements, { ts = Math.floor(Date.now() / 1000), tamper } = {}) => {
    const raw = JSON.stringify({ movements });
    const signature = signatureFor(secret, ts, tamper ? `${raw} ` : raw);
    return call('POST', `/api/v1/bank-inbound/${connectionId}`, {
      raw, headers: { 'x-splite-timestamp': String(ts), 'x-splite-signature': signature }
    });
  };

  const reference = () => String(Date.now()).slice(-9) + String(++seq).padStart(3, '0');

  /** Un aviso pendiente de 100 Bs + 10 de propina en una mesa nueva. */
  async function pendingClaim(tenant = restaurant, over = {}) {
    const table = await fixtures.createTable(tenant.id, { name: `B${++seq}` });
    const bill = await fixtures.createBill({ restaurantId: tenant.id, tableId: table.id, totalDue: 20000, totalDueVes: 20000 });
    const ref = over.reference ?? reference();
    const claim = await claims.declareClaim({
      restaurantId: tenant.id, billId: bill.id, amountVes: '10000', tipVes: 1000, reference: ref,
      phoneOrigin: '04141234567', bankOrigin: '0105', payer: { type: 'GUEST', id: null }
    });
    return { claim, reference: ref, billId: bill.id };
  }

  const statusOf = async id => (await db.query('SELECT status FROM payments WHERE id = $1', [id])).rows[0].status;
  const matchOf = async id => (await db.query('SELECT outcome, auto_confirmed FROM payment_bank_matches WHERE payment_id = $1', [id])).rows[0];

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Bank Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Bank Tenant' });
    ownerToken = await mint(restaurant, 'OWNER');
    cashierToken = await mint(restaurant, 'CASHIER');
    waiterToken = await mint(restaurant, 'WAITER');
    otherOwnerToken = await mint(other, 'OWNER');

    server = app.listen(0);
    server.unref();
    await new Promise(resolve => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    for (const tenant of [restaurant, other]) {
      if (!tenant) continue;
      await db.query('DELETE FROM bank_movements WHERE restaurant_id = $1', [tenant.id]);
      await db.query('DELETE FROM bank_connections WHERE restaurant_id = $1', [tenant.id]);
      await fixtures.destroyRestaurant(tenant.id);
    }
    await db.close();
    await closeRedis();
  });

  const createWebhook = async (token = ownerToken) => (await call('POST', '/api/v1/bank-connections', {
    body: { kind: 'WEBHOOK', label: `Servicio ${++seq}` }, token
  })).body;

  it('un movimiento firmado que casa deja el aviso sugerido, no confirmado', async () => {
    const { connection, secret, path } = await createWebhook();
    assert.ok(secret, 'el secreto sale al crear');
    assert.equal(path, `/api/v1/bank-inbound/${connection.id}`);
    assert.equal(connection.autoConfirm, false, 'la confianza está apagada por defecto');

    const { claim, reference: ref } = await pendingClaim();
    const res = await push(connection.id, secret, [{
      reference: ref, amount: '110,00', phoneOrigin: '584141234567', bankCode: '0105', date: '24/09/2026'
    }]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inserted, 1);
    assert.ok(res.body.matches.matched >= 1);

    assert.equal(await statusOf(claim.id), 'PENDING', 'sin confianza, sólo sugiere');
    assert.equal((await matchOf(claim.id)).outcome, 'MATCHED');

    const queue = await call('GET', '/api/v1/payments/claims', { token: ownerToken });
    const row = queue.body.data.find(c => c.id === claim.id);
    assert.equal(row.bankMatch.outcome, 'MATCHED');
    assert.equal(row.bankMatch.movementReference, ref);
  });

  it('con la confianza encendida, el banco confirma solo; y el movimiento queda gastado', async () => {
    const { connection, secret } = await createWebhook();
    const patched = await call('PATCH', `/api/v1/bank-connections/${connection.id}`, {
      body: { autoConfirm: true }, token: ownerToken
    });
    assert.equal(patched.status, 200);

    const { claim, reference: ref } = await pendingClaim();
    const res = await push(connection.id, secret, [{ reference: ref, amountMinor: '11000' }]);
    assert.equal(res.body.matches.autoConfirmed, 1, JSON.stringify(res.body));
    assert.equal(await statusOf(claim.id), 'SUCCEEDED');
    assert.equal((await matchOf(claim.id)).auto_confirmed, true);

    const { rows: [mv] } = await db.query(
      'SELECT matched_payment_id FROM bank_movements WHERE restaurant_id = $1 AND reference = $2',
      [restaurant.id, ref]
    );
    assert.equal(mv.matched_payment_id, claim.id);

    const { rows: [t] } = await db.query(
      "SELECT actor_type FROM payment_transitions WHERE payment_id = $1 AND to_status = 'SUCCEEDED'", [claim.id]
    );
    assert.equal(t.actor_type, 'PROVIDER', 'queda escrito que lo confirmó el banco, no una persona');
  });

  it('dos avisos con la referencia de un solo pago: no se confirma ninguno', async () => {
    const { connection, secret } = await createWebhook();
    await call('PATCH', `/api/v1/bank-connections/${connection.id}`, { body: { autoConfirm: true }, token: ownerToken });
    const ref = reference();
    const first = await pendingClaim(restaurant, { reference: ref });
    // La referencia está en un índice único de avisos pendientes: la copia
    // lleva otro prefijo con los mismos últimos dígitos, que es lo que compara
    // el matcher.
    const copy = await pendingClaim(restaurant, { reference: `9${ref}` });
    await push(connection.id, secret, [{ reference: ref, amountMinor: '11000' }]);

    assert.equal(await statusOf(first.claim.id), 'PENDING');
    assert.equal(await statusOf(copy.claim.id), 'PENDING');
    assert.equal((await matchOf(first.claim.id)).outcome, 'AMBIGUOUS');
    assert.equal((await matchOf(copy.claim.id)).outcome, 'AMBIGUOUS');
  });

  it('el mismo movimiento dos veces entra una', async () => {
    const { connection, secret } = await createWebhook();
    const ref = reference();
    const once = await push(connection.id, secret, [{ reference: ref, amountMinor: '5000' }]);
    const twice = await push(connection.id, secret, [{ reference: ref, amountMinor: '5000' }]);
    assert.equal(once.body.inserted, 1);
    assert.equal(twice.body.inserted, 0);
    assert.equal(twice.body.duplicates, 1);
  });

  it('firma mala, hora vieja o conexión inventada: el mismo 401', async () => {
    const { connection, secret } = await createWebhook();
    const mv = [{ reference: reference(), amountMinor: '5000' }];

    const tampered = await push(connection.id, secret, mv, { tamper: true });
    assert.equal(tampered.status, 401);
    const old = await push(connection.id, secret, mv, { ts: Math.floor(Date.now() / 1000) - 600 });
    assert.equal(old.status, 401);
    const wrongSecret = await push(connection.id, 'no-es-el-secreto', mv);
    assert.equal(wrongSecret.status, 401);
    const invented = await push('11111111-1111-4111-8111-111111111111', secret, mv);
    assert.equal(invented.status, 401);
    assert.equal(invented.body.error.code, tampered.body.error.code, 'no dice si la conexión existe');

    const { rows } = await db.query('SELECT count(*)::int AS n FROM bank_movements WHERE connection_id = $1', [connection.id]);
    assert.equal(rows[0].n, 0, 'nada de eso guardó movimientos');
  });

  it('rotar la firma invalida la anterior', async () => {
    const { connection, secret } = await createWebhook();
    const rotated = await call('POST', `/api/v1/bank-connections/${connection.id}/rotate-secret`, { token: ownerToken });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.secret, secret);
    const withOld = await push(connection.id, secret, [{ reference: reference(), amountMinor: '5000' }]);
    assert.equal(withOld.status, 401);
    const withNew = await push(connection.id, rotated.body.secret, [{ reference: reference(), amountMinor: '5000' }]);
    assert.equal(withNew.status, 200);
  });

  it('un estado de cuenta subido desde el panel; filas ilegibles con su motivo', async () => {
    const created = await call('POST', '/api/v1/bank-connections', {
      body: { kind: 'STATEMENT_IMPORT', label: 'Estado de cuenta' }, token: ownerToken
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.secret, undefined, 'un estado de cuenta no tiene firma');
    const id = created.body.connection.id;

    const { claim, reference: ref } = await pendingClaim();
    const res = await call('POST', `/api/v1/bank-connections/${id}/import`, {
      token: cashierToken,
      body: { movements: [
        { reference: ref, amount: '110,00', date: '24/09/2026', description: 'PAGO MOVIL' },
        { reference: reference(), amount: '-50,00' },
        { reference: '12', amount: '10,00' }
      ] }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.inserted, 1);
    assert.deepEqual(res.body.rejected, [{ index: 1, reason: 'debit' }, { index: 2, reason: 'reference' }]);
    assert.equal((await matchOf(claim.id)).outcome, 'MATCHED');

    const listed = await call('GET', `/api/v1/bank-connections/${id}/movements`, { token: cashierToken });
    assert.ok(listed.body.data.some(m => m.reference === ref));
  });

  it('confirmar a mano un aviso que el banco ya casó gasta el movimiento', async () => {
    const { connection, secret } = await createWebhook();
    const { claim, reference: ref } = await pendingClaim();
    await push(connection.id, secret, [{ reference: ref, amountMinor: '11000' }]);
    const confirmed = await call('POST', `/api/v1/payments/claims/${claim.id}/confirm`, { token: cashierToken, body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const { rows: [mv] } = await db.query(
      'SELECT matched_payment_id FROM bank_movements WHERE restaurant_id = $1 AND reference = $2', [restaurant.id, ref]
    );
    assert.equal(mv.matched_payment_id, claim.id, 'otro aviso ya no puede apoyarse en ese pago');
  });

  it('quién puede qué', async () => {
    const asCashier = await call('POST', '/api/v1/bank-connections', {
      body: { kind: 'WEBHOOK', label: 'x' }, token: cashierToken
    });
    assert.equal(asCashier.status, 403, 'crear una conexión es del dueño');
    const { connection } = await createWebhook();
    const trust = await call('PATCH', `/api/v1/bank-connections/${connection.id}`, {
      body: { autoConfirm: true }, token: cashierToken
    });
    assert.equal(trust.status, 403, 'encender la confianza, también');
    const asWaiter = await call('GET', '/api/v1/bank-connections', { token: waiterToken });
    assert.equal(asWaiter.status, 403, 'un mesero no ve las conexiones');
  });

  it('otro restaurante no ve, no cambia ni importa en mis conexiones', async () => {
    const { connection } = await createWebhook();
    const list = await call('GET', '/api/v1/bank-connections', { token: otherOwnerToken });
    assert.ok(!list.body.data.some(c => c.id === connection.id));
    const patch = await call('PATCH', `/api/v1/bank-connections/${connection.id}`, {
      body: { autoConfirm: true }, token: otherOwnerToken
    });
    assert.equal(patch.status, 404);
    const imp = await call('POST', `/api/v1/bank-connections/${connection.id}/import`, {
      body: { movements: [{ reference: reference(), amountMinor: '5000' }] }, token: otherOwnerToken
    });
    assert.equal(imp.status, 404);
  });

  it('un movimiento de mi banco no confirma el aviso de otro restaurante', async () => {
    const { connection, secret } = await createWebhook();
    await call('PATCH', `/api/v1/bank-connections/${connection.id}`, { body: { autoConfirm: true }, token: ownerToken });
    const theirs = await pendingClaim(other);
    await push(connection.id, secret, [{ reference: theirs.reference, amountMinor: '11000' }]);
    assert.equal(await statusOf(theirs.claim.id), 'PENDING');
  });

  it('una conexión dada de baja deja de aceptar movimientos', async () => {
    const { connection, secret } = await createWebhook();
    await call('PATCH', `/api/v1/bank-connections/${connection.id}`, { body: { active: false }, token: ownerToken });
    const res = await push(connection.id, secret, [{ reference: reference(), amountMinor: '5000' }]);
    assert.equal(res.status, 401);
  });
});
