const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { skip } = require('./helpers/env');
const config = require('../../src/config');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const claims = require('../../src/services/paymentClaims');
const { encryptNotification } = require('../../src/payments/providers/mercantil/notification');
const app = require('../../src/app');

/**
 * Las notificaciones de pago de Mercantil, sobre HTTP, como las mandaría el
 * banco: un solo URL para todos los comercios, el RIF en `CompIdentif` y el
 * cuerpo cifrado con la llave de ese comercio.
 *
 * Casi todo son formas de que un mensaje NO entre: una llave que no es, un RIF
 * que no existe, un pago enviado en vez de recibido, el mismo pago dos veces.
 * Y que la llave, una vez guardada, no salga nunca.
 */
describe('notificaciones de pago de Mercantil', { skip }, () => {
  let server, base, restaurant, other, ownerToken, cashierToken, otherOwnerToken, seq = 0;

  const clearIpRateLimits = () => redis.del(
    'api:::ffff:127.0.0.1', 'api:127.0.0.1',
    'bank-inbound-mercantil:::ffff:127.0.0.1', 'bank-inbound-mercantil:127.0.0.1'
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

  const call = async (method, path, { body, token, headers = {}, raw, contentType = 'application/json' } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body || raw ? { 'content-type': contentType } : {}),
        ...headers
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
  };

  /** Un RIF que no use ninguna otra prueba ni ninguna otra corrida. */
  const freshRif = () => `J4${crypto.randomInt(10_000_000, 99_999_999)}`;
  const freshKey = () => `llave-${crypto.randomBytes(12).toString('hex')}`;
  const reference = () => String(Date.now()).slice(-9) + String(++seq).padStart(3, '0');

  const INFO = {
    guId: 'ad2a1719-f8af-10d1-60e7-d4e5d5b93464', channel: '0006', subchannel: '07',
    applId: 'OLB', personId: 'V11312786@J306993762', userId: '', token: '', action: ''
  };

  function notification(rif, over = {}) {
    return {
      infoMsg: INFO,
      webhookNotificationIn: {
        codigo: '00', mensajeCliente: 'Aprobada', mensajeSistema: 'Aprobada',
        referenciaBancoOrdenante: reference(), referenciaBancoBeneficiario: '',
        tipo: 'R', bancoOrdenante: '0102', bancoBeneficiario: '0105',
        idCliente: 'V000000010824244', tipoDatoCliente: 'CEL', numeroProductoCliente: '00584141234567',
        idComercio: rif.replace(/^([A-Z])(\d+)$/, (_, l, d) => l + d.padStart(15, '0')),
        tipoDatoComercio: 'CEL', numeroProductoComercio: '00584241234567',
        fecha: '20261007', hora: '1400', codigoMoneda: 'VES', monto: '110.00',
        numeroFactura: '0', numeroContrato: '0', concepto: 'Pago',
        ...over
      }
    };
  }

  /** El POST del banco. */
  const notify = (rif, key, payload, { contentType, headerRif = rif } = {}) => call(
    'POST', '/api/v1/bank-inbound/mercantil',
    {
      raw: JSON.stringify({ data: encryptNotification(payload, key) }),
      contentType,
      headers: headerRif === null ? {} : { CompIdentif: headerRif }
    }
  );

  /** Un aviso pendiente de 100 Bs + 10 de propina en una mesa nueva. */
  async function pendingClaim(tenant = restaurant) {
    const table = await fixtures.createTable(tenant.id, { name: `M${++seq}` });
    const bill = await fixtures.createBill({ restaurantId: tenant.id, tableId: table.id, totalDue: 20000, totalDueVes: 20000 });
    const ref = reference();
    const claim = await claims.declareClaim({
      restaurantId: tenant.id, billId: bill.id, amountVes: '10000', tipVes: 1000, reference: ref,
      phoneOrigin: '04141234567', bankOrigin: '0102', payer: { type: 'GUEST', id: null }
    });
    return { claim, reference: ref };
  }

  const statusOf = async id => (await db.query('SELECT status FROM payments WHERE id = $1', [id])).rows[0].status;
  const matchOf = async id => (await db.query('SELECT outcome FROM payment_bank_matches WHERE payment_id = $1', [id])).rows[0];
  const movementsOf = async connectionId => (await db.query(
    'SELECT reference, amount_minor, phone_origin, id_origin, bank_code, occurred_at FROM bank_movements WHERE connection_id = $1',
    [connectionId]
  )).rows;

  const createMercantil = async ({ rif = freshRif(), key = freshKey(), token = ownerToken, label = 'Mercantil' } = {}) => {
    const res = await call('POST', '/api/v1/bank-connections', {
      body: { kind: 'MERCANTIL_P2C', label, merchantRif: rif, masterKey: key }, token
    });
    return { ...res, rif, key };
  };

  before(async () => {
    await clearIpRateLimits();
    restaurant = await fixtures.createRestaurant({ name: 'Mercantil Tenant' });
    other = await fixtures.createRestaurant({ name: 'Other Mercantil Tenant' });
    ownerToken = await mint(restaurant, 'OWNER');
    cashierToken = await mint(restaurant, 'CASHIER');
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

  it('crear la conexión: guarda el RIF y la llave sellada, y nunca devuelve la llave', async () => {
    const rif = freshRif();
    const dashed = `${rif.slice(0, 1)}-${rif.slice(1, -1)}-${rif.slice(-1)}`;
    const created = await createMercantil({ rif: dashed });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.path, '/api/v1/bank-inbound/mercantil');
    assert.equal(created.body.secret, undefined, 'no hay secreto de firma');
    const { connection } = created.body;
    assert.equal(connection.kind, 'MERCANTIL_P2C');
    assert.equal(connection.merchantRif, rif, 'el RIF sin guiones');
    assert.equal(connection.hasKey, true);
    assert.equal(connection.bankCode, '0105');
    assert.equal(connection.inboundPath, '/api/v1/bank-inbound/mercantil');
    assert.ok(!created.text.includes(created.key), 'la llave no sale al crear');

    const list = await call('GET', '/api/v1/bank-connections', { token: cashierToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some(c => c.id === connection.id));
    assert.ok(!list.text.includes(created.key), 'ni al listar');
    assert.ok(!list.text.includes('credentials'), 'ni la columna sellada');

    const { rows } = await db.query('SELECT credentials_encrypted FROM bank_connections WHERE id = $1', [connection.id]);
    assert.ok(Buffer.isBuffer(rows[0].credentials_encrypted));
    assert.ok(!rows[0].credentials_encrypted.toString('latin1').includes(created.key), 'sellada en la base');

    const audit = await db.query(
      `SELECT details::text AS details FROM audit_logs WHERE resource_id = $1`, [connection.id]
    );
    assert.ok(audit.rows.length >= 1);
    for (const row of audit.rows) assert.ok(!row.details.includes(created.key), 'ni en la auditoría');
  });

  it('un pago recibido entra como movimiento y casa con el aviso pendiente', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const { claim, reference: ref } = await pendingClaim();

    const res = await notify(rif, key, notification(rif, { referenciaBancoOrdenante: ref }));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, {
      infoMsg: INFO, code: 0, codigo: '0000',
      mensajeCliente: 'Notificacion recibida con éxito!', mensajeSistema: 'Notificacion recibida con éxito!',
      idRegistro: '00000'
    });

    const [movement] = await movementsOf(connection.id);
    assert.equal(movement.reference, ref);
    assert.equal(String(movement.amount_minor), '11000');
    assert.equal(movement.phone_origin, '00584141234567');
    assert.equal(movement.id_origin, 'V10824244');
    assert.equal(movement.bank_code, '0102');
    assert.equal(new Date(movement.occurred_at).toISOString(), '2026-10-07T18:00:00.000Z');

    assert.equal((await matchOf(claim.id)).outcome, 'MATCHED');
    assert.equal(await statusOf(claim.id), 'PENDING', 'sin confianza, sólo sugiere');
  });

  it('el mismo pago dos veces: la segunda es «Operación duplicada» y no se guarda otra vez', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const payload = notification(rif);
    assert.equal((await notify(rif, key, payload)).body.mensajeCliente, 'Notificacion recibida con éxito!');
    const again = await notify(rif, key, payload);
    assert.equal(again.status, 200);
    assert.equal(again.body.codigo, '0000');
    assert.equal(again.body.mensajeCliente, 'Operación duplicada');
    assert.equal((await movementsOf(connection.id)).length, 1);
  });

  it('con la confianza encendida, la notificación confirma el aviso sola', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const patched = await call('PATCH', `/api/v1/bank-connections/${connection.id}`, {
      body: { autoConfirm: true }, token: ownerToken
    });
    assert.equal(patched.status, 200);
    const { claim, reference: ref } = await pendingClaim();
    assert.equal((await notify(rif, key, notification(rif, { referenciaBancoOrdenante: ref }))).status, 200);
    assert.equal(await statusOf(claim.id), 'SUCCEEDED');
  });

  it('el RIF de la cabecera con guiones o con ceros llega a la misma conexión', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const padded = rif.slice(0, 1) + rif.slice(1).padStart(15, '0');
    const res = await notify(rif, key, notification(rif), { headerRif: padded });
    assert.equal(res.status, 200, res.text);
    assert.equal((await movementsOf(connection.id)).length, 1);
  });

  it('otra llave, un RIF que no existe o sin cabecera: el mismo 401, y nada se guarda', async () => {
    const { body: { connection }, rif, key } = await createMercantil();

    const wrongKey = await notify(rif, freshKey(), notification(rif));
    const unknownRif = await notify(freshRif(), key, notification(rif));
    const noHeader = await notify(rif, key, notification(rif), { headerRif: null });
    const garbage = await call('POST', '/api/v1/bank-inbound/mercantil', {
      raw: JSON.stringify({ data: 'esto-no-es-base64-de-nada' }), headers: { CompIdentif: rif }
    });
    const noData = await call('POST', '/api/v1/bank-inbound/mercantil', { raw: '{}', headers: { CompIdentif: rif } });

    for (const res of [wrongKey, unknownRif, noHeader, garbage, noData]) {
      assert.equal(res.status, 401, res.text);
      assert.equal(res.body.error.code, 'BANK_INBOUND_UNAUTHORIZED');
    }
    const sansRequest = ({ error: { requestId, ...rest } }) => rest;
    assert.deepEqual(sansRequest(wrongKey.body), sansRequest(unknownRif.body), 'no dice si el RIF existe');
    assert.equal((await movementsOf(connection.id)).length, 0);

    const { rows } = await db.query('SELECT last_error FROM bank_connections WHERE id = $1', [connection.id]);
    assert.match(rows[0].last_error, /llave/, 'el panel avisa de que la llave no abre los mensajes');
    assert.ok(!rows[0].last_error.includes(key));
  });

  it('con IPs del banco configuradas, desde otra IP es el mismo 401 aunque la llave sea buena', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const allowed = config.payments.mercantil.notifyAllowedIps;
    allowed.push('203.0.113.7');
    try {
      const refused = await notify(rif, key, notification(rif));
      assert.equal(refused.status, 401);
      assert.equal(refused.body.error.code, 'BANK_INBOUND_UNAUTHORIZED');
      assert.equal((await movementsOf(connection.id)).length, 0);
      allowed.push('127.0.0.1');
      assert.equal((await notify(rif, key, notification(rif))).status, 200, 'desde una IP de la lista, sí');
    } finally {
      allowed.length = 0;
    }
  });

  it('un pago enviado, rechazado o en dólares se contesta como recibido y no se guarda', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    for (const over of [{ tipo: 'E' }, { codigo: '51' }, { codigoMoneda: 'USD' }]) {
      const res = await notify(rif, key, notification(rif, over));
      assert.equal(res.status, 200, JSON.stringify(over));
      assert.equal(res.body.codigo, '0000', 'reintentarlo no cambiaría nada');
    }
    assert.equal((await movementsOf(connection.id)).length, 0);
  });

  it('un mensaje que se abre pero no se entiende: 200 con 9999, anotado en la conexión', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const res = await notify(rif, key, notification(rif, { referenciaBancoOrdenante: 'ABC', monto: '110.00' }));
    assert.equal(res.status, 200);
    assert.equal(res.body.codigo, '9999');
    assert.deepEqual(res.body.infoMsg, INFO);
    assert.equal((await movementsOf(connection.id)).length, 0);
    const { rows } = await db.query('SELECT last_error FROM bank_connections WHERE id = $1', [connection.id]);
    assert.ok(rows[0].last_error);
  });

  it('el cuerpo como texto también se lee', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const res = await notify(rif, key, notification(rif), { contentType: 'text/plain' });
    assert.equal(res.status, 200, res.text);
    assert.equal((await movementsOf(connection.id)).length, 1);
  });

  it('cambiar la llave: la nueva abre los mensajes y la vieja deja de abrirlos', async () => {
    const { body: { connection }, rif, key } = await createMercantil();
    const next = freshKey();
    const patched = await call('PATCH', `/api/v1/bank-connections/${connection.id}`, {
      body: { masterKey: next }, token: ownerToken
    });
    assert.equal(patched.status, 200, patched.text);
    assert.ok(!patched.text.includes(next), 'tampoco al cambiarla');
    assert.equal((await notify(rif, key, notification(rif))).status, 401);
    assert.equal((await notify(rif, next, notification(rif))).status, 200);

    const audit = await db.query(
      `SELECT action, details::text AS details FROM audit_logs WHERE resource_id = $1 AND action = 'BANK_CONNECTION_KEY_CHANGED'`,
      [connection.id]
    );
    assert.equal(audit.rows.length, 1);
    assert.ok(!audit.rows[0].details.includes(next));
  });

  it('un RIF ya conectado en otro restaurante: 409, y dado de baja queda libre', async () => {
    const first = await createMercantil();
    const taken = await createMercantil({ rif: first.rif, token: otherOwnerToken });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error.code, 'BANK_CONNECTION_RIF_TAKEN');

    const removed = await call('PATCH', `/api/v1/bank-connections/${first.body.connection.id}`, {
      body: { active: false }, token: ownerToken
    });
    assert.equal(removed.status, 200);
    assert.equal((await notify(first.rif, first.key, notification(first.rif))).status, 401, 'de baja no recibe');
    const reused = await createMercantil({ rif: first.rif, token: otherOwnerToken });
    assert.equal(reused.status, 201, reused.text);
  });

  it('RIF y llave sólo en una conexión de Mercantil, y ahí obligatorios', async () => {
    const webhookWithKey = await call('POST', '/api/v1/bank-connections', {
      body: { kind: 'WEBHOOK', label: 'x', masterKey: freshKey() }, token: ownerToken
    });
    assert.equal(webhookWithKey.status, 400);
    const noKey = await call('POST', '/api/v1/bank-connections', {
      body: { kind: 'MERCANTIL_P2C', label: 'x', merchantRif: freshRif() }, token: ownerToken
    });
    assert.equal(noKey.status, 400);
    const badRif = await createMercantil({ rif: '12345678' });
    assert.equal(badRif.status, 400);

    const webhook = await call('POST', '/api/v1/bank-connections', {
      body: { kind: 'WEBHOOK', label: 'x' }, token: ownerToken
    });
    const patch = await call('PATCH', `/api/v1/bank-connections/${webhook.body.connection.id}`, {
      body: { masterKey: freshKey() }, token: ownerToken
    });
    assert.equal(patch.status, 409);
    assert.equal(patch.body.error.code, 'BANK_CONNECTION_KIND_MISMATCH');
  });

  it('sólo el dueño conecta Mercantil o cambia la llave', async () => {
    const asCashier = await createMercantil({ token: cashierToken });
    assert.equal(asCashier.status, 403);
    const { body: { connection } } = await createMercantil();
    const patch = await call('PATCH', `/api/v1/bank-connections/${connection.id}`, {
      body: { masterKey: freshKey() }, token: cashierToken
    });
    assert.equal(patch.status, 403);
  });

  it('la notificación de un comercio no toca los avisos de otro restaurante', async () => {
    const { rif, key } = await createMercantil();
    const { claim, reference: ref } = await pendingClaim(other);
    assert.equal((await notify(rif, key, notification(rif, { referenciaBancoOrdenante: ref }))).status, 200);
    const match = await matchOf(claim.id);
    assert.notEqual(match && match.outcome, 'MATCHED');
    assert.equal(await statusOf(claim.id), 'PENDING');
  });
});
