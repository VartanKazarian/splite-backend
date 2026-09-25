const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { skip } = require('./helpers/env');
const db = require('../../src/connectors/base');
const { redis, closeRedis } = require('../../src/connectors/redis');
const config = require('../../src/config');
const fixtures = require('./helpers/fixtures');
const { signAccessToken } = require('../../src/utils/tokens');
const operators = require('../../src/services/operators');
const billing = require('../../src/services/platformBilling');
const billingRun = require('../../src/services/billingRun');
const mailer = require('../../src/services/mailer');
const fx = require('../../src/services/fx');
const app = require('../../src/app');

/**
 * Cobros, segunda vuelta: lo que ve el restaurante, «Ya pagué», la renovación
 * nocturna, los recordatorios, la suspensión y las métricas.
 *
 * Lo que más importa probar es lo que NO debe pasar: que el restaurante vea
 * las notas internas de Splite, que un aviso cuente como pago sin que nadie lo
 * confirme, que se renueve a quien está suspendido o en prueba, que un
 * recordatorio salga dos veces, y que suspender deje a un comensal sin poder
 * pagar una cuenta que ya estaba abierta.
 */
describe('cobros: segunda vuelta', { skip }, () => {
  let server, base, seq = 0;
  const stamp = Date.now();
  const today = () => fx.caracasToday();

  const clear = async () => {
    const keys = [...await redis.keys('*admin-auth*'), ...await redis.keys('auth:acct:*')];
    await redis.del('api:::ffff:127.0.0.1', 'api:127.0.0.1', ...keys);
  };
  beforeEach(clear);

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

  /** Un operador ya dado de alta, sin pasar por la pantalla (eso lo prueba admin.integration). */
  async function operatorToken(role) {
    const email = `r2-${role.toLowerCase()}-${++seq}-${stamp}@example.com`;
    await operators.createOperator({ email, displayName: 'R2', role });
    const { rows } = await db.query(
      `UPDATE platform_operators SET password_hash = 'x', activated_at = NOW(), setup_token_hash = NULL
        WHERE email = $1 RETURNING id, email, role`, [email]
    );
    return { token: operators.signSession(rows[0]), op: rows[0] };
  }

  async function owner(restaurant, role = 'OWNER') {
    const email = `${role.toLowerCase()}-${++seq}-${stamp}@example.com`;
    const { rows } = await db.query(
      `INSERT INTO users (restaurant_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [restaurant.id, email, role]
    );
    return { token: signAccessToken({ id: rows[0].id, restaurantId: restaurant.id, role }), email };
  }

  /** Un cliente PRO con precio pactado, para no depender de la lista que tocan otras pruebas. */
  async function payingClient(name, priceUsd = '2900') {
    const r = await fixtures.createRestaurant({ name: `${name} ${stamp}` });
    await db.query("UPDATE restaurants SET plan_tier = 'PRO', trial_ends_at = NULL WHERE id = $1", [r.id]);
    await db.query(
      `INSERT INTO restaurant_subscriptions (restaurant_id, custom_price_usd) VALUES ($1, $2)`,
      [r.id, priceUsd]
    );
    return r;
  }

  let admin, support;

  before(async () => {
    await clear();
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    admin = await operatorToken('ADMIN');
    support = await operatorToken('SUPPORT');
  });

  after(async () => {
    server.close();
    await closeRedis();
    await db.close();
  });

  it('los precios de salida quedan puestos: 9, 29 y 59 al mes', async () => {
    const { rows } = await db.query(
      `SELECT tier, amount_usd FROM plan_prices
        WHERE billing_cycle = 'MONTHLY' AND effective_from = DATE '2026-09-25' ORDER BY amount_usd`
    );
    const byTier = Object.fromEntries(rows.map(r => [r.tier, String(r.amount_usd)]));
    // PRO puede haberlo pisado otra prueba en el mismo día; STARTER y ENTERPRISE no los toca nadie.
    assert.equal(byTier.STARTER, '900');
    assert.equal(byTier.ENTERPRISE, '5900');
  });

  describe('tu suscripción, desde el panel', () => {
    it('el dueño la ve, sin las notas internas de Splite; el mesero no', async () => {
      const r = await payingClient('Panel');
      await call('PATCH', `/api/v1/admin/clients/${r.id}/subscription`, {
        token: admin.token, body: { notes: 'NOTA-INTERNA-no-mostrar' }
      });
      await billing.createCharge({ restaurantId: r.id, via: 'test' });
      const own = await owner(r);
      const res = await call('GET', '/api/v1/account/subscription', { token: own.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.subscription.tier, 'PRO');
      assert.equal(res.body.subscription.balanceUsd, '2900');
      assert.equal(res.body.charges.length, 1);
      assert.ok(!JSON.stringify(res.body).includes('NOTA-INTERNA'), 'internal notes must not reach the restaurant');

      const waiter = await owner(r, 'WAITER');
      assert.equal((await call('GET', '/api/v1/account/subscription', { token: waiter.token })).status, 403);
    });

    it('los datos de cobro de Splite salen cuando el equipo los pone', async () => {
      const put = await call('PUT', '/api/v1/admin/settings/payment-details', {
        token: admin.token,
        body: { holder: 'Splite C.A.', idNumber: 'J-00000000-0', bankName: 'Mercantil', bankCode: '0105', phone: '04140000000' }
      });
      assert.equal(put.status, 200);
      assert.equal((await call('PUT', '/api/v1/admin/settings/payment-details', {
        token: support.token, body: { holder: 'x' }
      })).status, 403);

      const r = await payingClient('Datos');
      const own = await owner(r);
      const res = await call('GET', '/api/v1/account/subscription', { token: own.token });
      assert.equal(res.body.paymentDetails.bankCode, '0105');
      assert.equal(res.body.paymentDetails.holder, 'Splite C.A.');
    });
  });

  describe('«Ya pagué»', () => {
    it('un aviso no es un pago hasta que alguien de Splite lo confirma', async () => {
      const r = await payingClient('Aviso');
      const charge = await billing.createCharge({ restaurantId: r.id, via: 'test' });
      const own = await owner(r);
      const ref = String(stamp).slice(-8);

      const sent = await call('POST', '/api/v1/account/subscription/notices', {
        token: own.token,
        body: { chargeId: charge.id, method: 'PAGO_MOVIL', currency: 'VES', amount: '100000', reference: ref, paidOn: today() }
      });
      assert.equal(sent.status, 201, JSON.stringify(sent.body));
      assert.equal(sent.body.notice.status, 'PENDING');

      // Pendiente: el cargo sigue debiéndose entero.
      const beforeConfirm = await call('GET', '/api/v1/account/subscription', { token: own.token });
      assert.equal(beforeConfirm.body.subscription.balanceUsd, '2900');

      const dup = await call('POST', '/api/v1/account/subscription/notices', {
        token: own.token,
        body: { chargeId: charge.id, method: 'PAGO_MOVIL', currency: 'VES', amount: '100000', reference: ref, paidOn: today() }
      });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, 'SUBSCRIPTION_NOTICE_DUPLICATE');

      const pending = await call('GET', '/api/v1/admin/notices', { token: support.token });
      assert.ok(pending.body.data.some(n => n.id === sent.body.notice.id));

      const bySupport = await call('POST', `/api/v1/admin/notices/${sent.body.notice.id}/confirm`, {
        token: support.token, body: { fxRate: '100' }
      });
      assert.equal(bySupport.status, 403);

      // 1.000,00 Bs a 100 Bs/$ = 10 $.
      const ok = await call('POST', `/api/v1/admin/notices/${sent.body.notice.id}/confirm`, {
        token: admin.token, body: { fxRate: '100' }
      });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.payment.appliedUsd, '1000');
      assert.equal(ok.body.charge.remainingUsd, '1900');

      const again = await call('POST', `/api/v1/admin/notices/${sent.body.notice.id}/confirm`, {
        token: admin.token, body: { fxRate: '100' }
      });
      assert.equal(again.status, 409);

      const afterConfirm = await call('GET', '/api/v1/account/subscription', { token: own.token });
      assert.equal(afterConfirm.body.subscription.balanceUsd, '1900');
      assert.equal(afterConfirm.body.notices[0].status, 'CONFIRMED');
    });

    it('rechazado, el restaurante ve el motivo y puede volver a avisar con esa referencia', async () => {
      const r = await payingClient('Rechazo');
      await billing.createCharge({ restaurantId: r.id, via: 'test' });
      const own = await owner(r);
      const body = { method: 'ZELLE', currency: 'USD', amount: '2900', reference: 'ZL-998877', paidOn: today() };
      const first = await call('POST', '/api/v1/account/subscription/notices', { token: own.token, body });
      const rej = await call('POST', `/api/v1/admin/notices/${first.body.notice.id}/reject`, {
        token: admin.token, body: { reason: 'No aparece en la cuenta' }
      });
      assert.equal(rej.status, 200);
      const view = await call('GET', '/api/v1/account/subscription', { token: own.token });
      assert.equal(view.body.notices[0].rejectReason, 'No aparece en la cuenta');
      const retry = await call('POST', '/api/v1/account/subscription/notices', { token: own.token, body });
      assert.equal(retry.status, 201);
    });

    it('no se avisa el pago de un cargo de otro restaurante', async () => {
      const a = await payingClient('AvisoA');
      const b = await payingClient('AvisoB');
      const charge = await billing.createCharge({ restaurantId: a.id, via: 'test' });
      const own = await owner(b);
      const res = await call('POST', '/api/v1/account/subscription/notices', {
        token: own.token,
        body: { chargeId: charge.id, method: 'PAGO_MOVIL', currency: 'VES', amount: '1000', paidOn: today() }
      });
      assert.equal(res.status, 404);
    });
  });

  describe('suspender', () => {
    it('no deja abrir cuentas nuevas, pero la mesa que ya tenía cuenta sigue', async () => {
      const r = await payingClient('Suspendido');
      const own = await owner(r);
      const busy = await fixtures.createTable(r.id, { name: `S${++seq}` });
      const free = await fixtures.createTable(r.id, { name: `S${++seq}` });
      const bill = await fixtures.createBill({ restaurantId: r.id, tableId: busy.id, totalDue: 10000, totalDueVes: 10000 });

      await call('PATCH', `/api/v1/admin/clients/${r.id}/subscription`, {
        token: admin.token, body: { status: 'SUSPENDED', reason: 'tres meses sin pagar' }
      });

      const open = await call('POST', '/api/v1/bills', {
        token: own.token, body: { tableId: free.id, totalDueMinorUnits: '5000' }
      });
      assert.equal(open.status, 403);
      assert.equal(open.body.error.code, 'SUBSCRIPTION_SUSPENDED');

      const existing = await call('GET', `/api/v1/bills/${bill.id}`, { token: own.token });
      assert.equal(existing.status, 200, 'an open bill must stay readable and payable');

      await call('PATCH', `/api/v1/admin/clients/${r.id}/subscription`, {
        token: admin.token, body: { status: 'ACTIVE' }
      });
      const reopened = await call('POST', '/api/v1/bills', {
        token: own.token, body: { tableId: free.id, totalDueMinorUnits: '5000' }
      });
      assert.equal(reopened.status, 201, JSON.stringify(reopened.body));
    });
  });

  describe('el pase nocturno', () => {
    it('renueva hasta ponerse al día, y no toca pruebas ni suspendidos ni a quien no empezó a pagar', async () => {
      const t = today();
      const active = await payingClient('Renueva');
      await billing.createCharge({ restaurantId: active.id, periodStart: billing.addMonths(t, -2), via: 'test' });

      const suspended = await payingClient('NoRenueva');
      await billing.createCharge({ restaurantId: suspended.id, periodStart: billing.addMonths(t, -2), via: 'test' });
      await db.query("UPDATE restaurant_subscriptions SET status = 'SUSPENDED' WHERE restaurant_id = $1", [suspended.id]);

      const neverBilled = await payingClient('SinEmpezar');

      await billingRun.renew({ today: t });

      const count = async id => (await db.query(
        "SELECT count(*)::INT AS n, max(period_end) AS last FROM subscription_charges WHERE restaurant_id = $1 AND status <> 'VOID'", [id]
      )).rows[0];
      const a = await count(active.id);
      assert.equal(a.n, 3, 'two months back plus the current period');
      assert.ok(billing._internals.day(a.last) > t);
      assert.equal((await count(suspended.id)).n, 1);
      assert.equal((await count(neverBilled.id)).n, 0);

      // Una segunda pasada el mismo día no cobra nada más.
      await billingRun.renew({ today: t });
      assert.equal((await count(active.id)).n, 3);
    });

    it('cada recordatorio sale una sola vez, y el que falla se reintenta', async () => {
      const t = today();
      const r = await payingClient('Recuerda');
      const own = await owner(r);
      await billing.createCharge({ restaurantId: r.id, periodStart: billing.addDays(t, -20), via: 'test' });

      const sent = [];
      const original = mailer.send;
      let fail = true;
      mailer.send = async msg => {
        if (!String(msg.to).includes(own.email)) return { sent: true };
        if (fail) return { sent: false, error: 'smtp down' };
        sent.push(msg);
        return { sent: true };
      };
      try {
        await billingRun.remind({ today: t });
        assert.equal(sent.length, 0, 'the failed send is not counted');
        fail = false;
        await billingRun.remind({ today: t });
        assert.equal(sent.length, 1);
        assert.match(sent[0].subject, /una semana vencida/);
        assert.match(sent[0].text, /\$29,00/);
        await billingRun.remind({ today: t });
        assert.equal(sent.length, 1, 'the same reminder must not go twice');
      } finally {
        mailer.send = original;
      }
      const { rows } = await db.query(
        `SELECT kind FROM billing_reminders b JOIN subscription_charges c ON c.id = b.charge_id
          WHERE c.restaurant_id = $1 ORDER BY kind`, [r.id]
      );
      // El de vencido y el de nuevo cargo quedan apuntados sin mandarse: nació ya vencido.
      assert.deepEqual(rows.map(x => x.kind), ['ISSUED', 'OVERDUE', 'OVERDUE_7']);
    });
  });

  describe('métricas y solicitudes', () => {
    it('las métricas cuentan los avisos pendientes y dan seis meses', async () => {
      const res = await call('GET', '/api/v1/admin/metrics', { token: support.token });
      assert.equal(res.status, 200);
      assert.equal(res.body.months.length, 6);
      assert.equal(typeof res.body.pendingNotices, 'number');
      assert.match(res.body.monthlyRecurringUsd, /^\d+$/);
    });

    it('una solicitud se marca contactada con el operador en el rastro', async () => {
      const { rows } = await db.query(
        `INSERT INTO restaurant_signups (restaurant_name, rif, rif_checksum_ok, email, phone, token_hash, expires_at)
         VALUES ($1, $2, true, $3, '04140000000', $4, NOW() + INTERVAL '1 day') RETURNING id`,
        [`Lead ${stamp}`, `J${String(stamp).slice(-9)}`, `lead-${stamp}@example.com`, crypto.randomBytes(32).toString('hex')]
      );
      const list = await call('GET', '/api/v1/admin/leads', { token: support.token });
      assert.ok(list.body.data.some(l => l.id === rows[0].id));
      const marked = await call('POST', `/api/v1/admin/leads/${rows[0].id}/status`, {
        token: admin.token, body: { status: 'CONTACTED', notes: 'llamado, interesado' }
      });
      assert.equal(marked.status, 200);
      assert.equal(marked.body.lead.status, 'CONTACTED');
      const { rows: trail } = await db.query(
        "SELECT operator_id FROM operator_audit WHERE action = 'LEAD_CONTACTED' AND resource_id = $1", [rows[0].id]
      );
      assert.equal(trail[0].operator_id, admin.op.id);

      if (!config.onboarding.enabled) {
        const inv = await call('POST', `/api/v1/admin/leads/${rows[0].id}/invite`, { token: admin.token });
        assert.equal(inv.status, 409);
        assert.equal(inv.body.error.code, 'ONBOARDING_DISABLED');
      }
    });
  });
});
