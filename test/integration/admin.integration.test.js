const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const operators = require('../../src/services/operators');
const totp = require('../../src/services/totp');
const fx = require('../../src/services/fx');
const app = require('../../src/app');

/**
 * La consola de Splite, sobre HTTP.
 *
 * Es la única superficie que ve a todos los restaurantes, así que la mitad de
 * esto son puertas que tienen que estar cerradas: una sesión de restaurante no
 * entra, una de operador no sirve en el panel, sin código no se entra, un
 * código no vale dos veces, SUPPORT no escribe y un operador desactivado queda
 * fuera en la petición siguiente.
 */
describe('consola de operador', { skip }, () => {
  let server, base, seq = 0;
  const stamp = Date.now();

  const clearIpRateLimits = async () => {
    const keys = await redis.keys('*admin-auth*');
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', ...keys);
    // El limitador por cuenta guarda el correo con hash: se limpian todos.
    const throttle = await redis.keys('auth:acct:*');
    if (throttle.length) await redis.del(...throttle);
  };
  beforeEach(clearIpRateLimits);

  const call = async (method, path, { body, token } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const PASSWORD = 'consola-segura-2026!';

  /** El código del autenticador para un paso concreto. */
  const codeAt = (secret, offset = 0) => totp.codeForStep(secret, totp.stepAt() + offset);

  /** Alta completa de un operador; devuelve su sesión y su secreto. */
  async function onboard(role) {
    const email = `op-${role.toLowerCase()}-${++seq}-${stamp}@example.com`;
    const { token } = await operators.createOperator({ email, displayName: `Op ${seq}`, role });
    const start = await call('POST', '/api/v1/admin/auth/setup/start', { body: { token } });
    assert.equal(start.status, 200);
    const done = await call('POST', '/api/v1/admin/auth/setup/complete', {
      body: { token, password: PASSWORD, code: codeAt(start.body.secret) }
    });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    return { email, secret: start.body.secret, token: done.body.accessToken };
  }

  let adminOp, supportOp;

  before(async () => {
    await clearIpRateLimits();
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    adminOp = await onboard('ADMIN');
    supportOp = await onboard('SUPPORT');
  });

  after(async () => {
    server.close();
    await closeRedis();
    await db.close();
  });

  describe('alta y entrada', () => {
    it('el enlace de alta pide un código válido, una contraseña larga y sirve una sola vez', async () => {
      const email = `op-setup-${stamp}@example.com`;
      const { token } = await operators.createOperator({ email, displayName: 'Setup', role: 'ADMIN' });
      const start = await call('POST', '/api/v1/admin/auth/setup/start', { body: { token } });
      assert.equal(start.status, 200);
      assert.match(start.body.otpauthUri, /^otpauth:\/\/totp\//);
      assert.equal(start.body.email, email);

      const badCode = await call('POST', '/api/v1/admin/auth/setup/complete', {
        body: { token, password: PASSWORD, code: '000000' }
      });
      assert.equal(badCode.status, 401);
      assert.equal(badCode.body.error.code, 'MFA_CODE_INVALID');

      const shortPassword = await call('POST', '/api/v1/admin/auth/setup/complete', {
        body: { token, password: 'corta-12345', code: codeAt(start.body.secret) }
      });
      assert.equal(shortPassword.status, 400);

      const ok = await call('POST', '/api/v1/admin/auth/setup/complete', {
        body: { token, password: PASSWORD, code: codeAt(start.body.secret) }
      });
      assert.equal(ok.status, 200);
      assert.ok(ok.body.accessToken);

      const again = await call('POST', '/api/v1/admin/auth/setup/start', { body: { token } });
      assert.equal(again.status, 404);
      assert.equal(again.body.error.code, 'OPERATOR_SETUP_INVALID');
    });

    it('sin el código del autenticador no se entra, y un código no vale dos veces', async () => {
      const noCode = await call('POST', '/api/v1/admin/auth/login', {
        body: { email: adminOp.email, password: PASSWORD, code: '123456' }
      });
      assert.equal(noCode.status, 401);
      assert.equal(noCode.body.error.code, 'INVALID_CREDENTIALS');

      const badPassword = await call('POST', '/api/v1/admin/auth/login', {
        body: { email: adminOp.email, password: 'no-es-la-buena-1234', code: codeAt(adminOp.secret, 1) }
      });
      assert.equal(badPassword.status, 401);
      assert.equal(badPassword.body.error.code, 'INVALID_CREDENTIALS');

      const code = codeAt(adminOp.secret, 1);
      const ok = await call('POST', '/api/v1/admin/auth/login', {
        body: { email: adminOp.email, password: PASSWORD, code }
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.operator.role, 'ADMIN');

      const replay = await call('POST', '/api/v1/admin/auth/login', {
        body: { email: adminOp.email, password: PASSWORD, code }
      });
      assert.equal(replay.status, 401, 'the same code twice must not open a second session');
    });

    it('un correo que no es de nadie responde igual que una contraseña mala', async () => {
      const res = await call('POST', '/api/v1/admin/auth/login', {
        body: { email: `nadie-${stamp}@example.com`, password: PASSWORD, code: '123456' }
      });
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'INVALID_CREDENTIALS');
    });
  });

  describe('sesiones separadas', () => {
    it('una sesión de restaurante no abre la consola', async () => {
      const restaurant = await fixtures.createRestaurant({ name: 'Intruso' });
      const { rows } = await db.query(
        `INSERT INTO users (restaurant_id, email, password_hash, role)
         VALUES ($1, $2, 'x', 'OWNER') RETURNING id`,
        [restaurant.id, `owner-intruso-${stamp}@example.com`]
      );
      const staffToken = signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role: 'OWNER' });
      const res = await call('GET', '/api/v1/admin/clients', { token: staffToken });
      assert.equal(res.status, 401);
    });

    it('una sesión de consola no abre el panel de un restaurante', async () => {
      const res = await call('GET', '/api/v1/account', { token: adminOp.token });
      assert.equal(res.status, 401);
    });

    it('SUPPORT mira pero no cambia nada', async () => {
      const list = await call('GET', '/api/v1/admin/clients', { token: supportOp.token });
      assert.equal(list.status, 200);
      const restaurant = await fixtures.createRestaurant({ name: 'Solo mirar' });
      const change = await call('PATCH', `/api/v1/admin/clients/${restaurant.id}/plan`, {
        token: supportOp.token, body: { tier: 'PRO' }
      });
      assert.equal(change.status, 403);
      const price = await call('POST', '/api/v1/admin/prices', {
        token: supportOp.token, body: { tier: 'PRO', billingCycle: 'MONTHLY', amountUsd: '100' }
      });
      assert.equal(price.status, 403);
    });

    it('un operador desactivado queda fuera en la petición siguiente', async () => {
      const temp = await onboard('SUPPORT');
      assert.equal((await call('GET', '/api/v1/admin/me', { token: temp.token })).status, 200);
      await operators.setActive({ email: temp.email, active: false });
      assert.equal((await call('GET', '/api/v1/admin/me', { token: temp.token })).status, 401);
    });
  });

  describe('cobros', () => {
    let restaurant;
    const plan = (id, body) => call('PATCH', `/api/v1/admin/clients/${id}/plan`, { token: adminOp.token, body });
    const charge = (id, body = {}) => call('POST', `/api/v1/admin/clients/${id}/charges`, { token: adminOp.token, body });
    const pay = (id, body) => call('POST', `/api/v1/admin/clients/${id}/payments`, { token: adminOp.token, body });
    const today = () => fx.caracasToday();

    before(async () => {
      // El precio del plan, con fecha de inicio en el pasado para que rija hoy.
      const price = await call('POST', '/api/v1/admin/prices', {
        token: adminOp.token,
        body: { tier: 'PRO', billingCycle: 'MONTHLY', amountUsd: '5900', effectiveFrom: '2020-01-01' }
      });
      assert.equal(price.status, 201, JSON.stringify(price.body));
      restaurant = await fixtures.createRestaurant({ name: `Cliente ${stamp}` });
    });

    it('a un restaurante en prueba no se le cobra: no tiene precio', async () => {
      const trial = await fixtures.createRestaurant({ name: 'En prueba' });
      await db.query("UPDATE restaurants SET plan_tier = 'TRIAL' WHERE id = $1", [trial.id]);
      const res = await charge(trial.id);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'SUBSCRIPTION_PRICE_MISSING');
    });

    it('cambiar el plan, cobrar el mes y registrar pagos en Bs y en $ hasta cerrarlo', async () => {
      const changed = await plan(restaurant.id, { tier: 'PRO', note: 'firmó el contrato' });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal(changed.body.tier, 'PRO');

      const created = await charge(restaurant.id);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const c = created.body.charge;
      assert.equal(c.amountUsd, '5900');
      assert.equal(c.periodStart, today());
      assert.equal(c.status, 'OPEN');

      const dup = await charge(restaurant.id, { periodStart: today() });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'SUBSCRIPTION_CHARGE_EXISTS');

      // 3.000,00 Bs a 100 Bs/$ son 30 $.
      const ves = await pay(restaurant.id, {
        chargeId: c.id, method: 'PAGO_MOVIL', currency: 'VES', amount: '300000', fxRate: '100.00',
        reference: '00123456', receivedOn: today()
      });
      assert.equal(ves.status, 201, JSON.stringify(ves.body));
      assert.equal(ves.body.payment.appliedUsd, '3000');
      assert.equal(ves.body.charge.status, 'OPEN');
      assert.equal(ves.body.charge.remainingUsd, '2900');

      const listed = await call('GET', '/api/v1/admin/clients', { token: adminOp.token });
      const row = listed.body.data.find(r => r.id === restaurant.id);
      assert.equal(row.balanceUsd, '2900');
      assert.equal(row.state, 'ACTIVE');
      assert.equal(row.priceUsd, '5900');

      const usd = await pay(restaurant.id, {
        chargeId: c.id, method: 'ZELLE', currency: 'USD', amount: '2900', receivedOn: today()
      });
      assert.equal(usd.status, 201);
      assert.equal(usd.body.charge.status, 'PAID');

      const voidPaid = await call('POST', `/api/v1/admin/charges/${c.id}/void`, {
        token: adminOp.token, body: { reason: 'por probar' }
      });
      assert.equal(voidPaid.status, 409);

      const detail = await call('GET', `/api/v1/admin/clients/${restaurant.id}`, { token: supportOp.token });
      assert.equal(detail.status, 200);
      assert.equal(detail.body.payments.length, 2);
      assert.equal(detail.body.client.balanceUsd, '0');
      const actions = detail.body.history.map(h => h.action);
      for (const a of ['PLAN_CHANGED', 'CHARGE_CREATED', 'PAYMENT_RECORDED']) assert.ok(actions.includes(a), a);
      assert.ok(detail.body.history.every(h => h.operatorEmail === adminOp.email));

      const { rows } = await db.query(
        "SELECT details FROM audit_logs WHERE restaurant_id = $1 AND action = 'PLAN_CHANGED'", [restaurant.id]
      );
      assert.equal(rows[0].details.via, 'console');
    });

    it('un pago en Bs sin tasa, con el BCV caído, se rechaza en vez de inventar una', async () => {
      const r = await fixtures.createRestaurant({ name: 'Sin tasa' });
      await plan(r.id, { tier: 'PRO' });
      const c = (await charge(r.id)).body.charge;
      const saved = fx.getRateFor;
      fx.getRateFor = async () => null;
      try {
        const res = await pay(r.id, { chargeId: c.id, method: 'PAGO_MOVIL', currency: 'VES', amount: '100000', receivedOn: today() });
        assert.equal(res.status, 400);
      } finally {
        fx.getRateFor = saved;
      }
    });

    it('un cargo vencido pone al cliente en OVERDUE y sale en el filtro', async () => {
      const r = await fixtures.createRestaurant({ name: 'Moroso' });
      await plan(r.id, { tier: 'PRO' });
      const old = await charge(r.id, { periodStart: '2026-01-01' });
      assert.equal(old.status, 201);
      const clients = await call('GET', '/api/v1/admin/clients?state=OVERDUE', { token: adminOp.token });
      assert.ok(clients.body.data.some(x => x.id === r.id));
      const charges = await call('GET', '/api/v1/admin/charges?status=OVERDUE', { token: adminOp.token });
      assert.ok(charges.body.data.some(x => x.id === old.body.charge.id && x.overdue));
    });

    it('el precio pactado manda sobre la lista, y un cargo anulado deja cobrar el periodo otra vez', async () => {
      const r = await fixtures.createRestaurant({ name: 'Pactado' });
      await plan(r.id, { tier: 'PRO' });
      const sub = await call('PATCH', `/api/v1/admin/clients/${r.id}/subscription`, {
        token: adminOp.token, body: { customPriceUsd: '4500', reason: 'socio fundador' }
      });
      assert.equal(sub.status, 200, JSON.stringify(sub.body));
      assert.equal(sub.body.client.priceUsd, '4500');

      const first = await charge(r.id, { periodStart: '2026-05-01' });
      assert.equal(first.body.charge.amountUsd, '4500');
      assert.equal(first.body.charge.periodEnd, '2026-06-01');

      const voided = await call('POST', `/api/v1/admin/charges/${first.body.charge.id}/void`, {
        token: adminOp.token, body: { reason: 'fecha equivocada' }
      });
      assert.equal(voided.status, 200);
      assert.equal(voided.body.charge.status, 'VOID');

      const again = await charge(r.id, { periodStart: '2026-05-01' });
      assert.equal(again.status, 201);
    });

    it('SUSPENDED gana a todo lo demás en la lista', async () => {
      const r = await fixtures.createRestaurant({ name: 'Suspendido' });
      await plan(r.id, { tier: 'PRO' });
      await call('PATCH', `/api/v1/admin/clients/${r.id}/subscription`, {
        token: adminOp.token, body: { status: 'SUSPENDED' }
      });
      const clients = await call('GET', '/api/v1/admin/clients?state=SUSPENDED', { token: supportOp.token });
      assert.ok(clients.body.data.some(x => x.id === r.id));
    });

    it('un cargo de otro restaurante no admite pagos por este', async () => {
      const a = await fixtures.createRestaurant({ name: 'A' });
      const b = await fixtures.createRestaurant({ name: 'B' });
      await plan(a.id, { tier: 'PRO' });
      const c = (await charge(a.id)).body.charge;
      const res = await pay(b.id, { chargeId: c.id, method: 'USD_CASH', currency: 'USD', amount: '5900', receivedOn: today() });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, 'SUBSCRIPTION_CHARGE_NOT_FOUND');
    });
  });
});
