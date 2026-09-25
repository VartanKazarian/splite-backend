const db = require('../connectors/base');
const { ApiError } = require('../errors');
const entitlements = require('./entitlements');
const fx = require('./fx');
const money = require('./money');
const plans = require('./plans');
const operators = require('./operators');

/**
 * Lo que Splite le cobra a cada restaurante, y el estado de cada cliente.
 *
 * Todos los importes van en céntimos de dólar de referencia (`amount_usd`). Un
 * restaurante paga en bolívares o en dólares; lo que un pago descuenta de un
 * cargo se fija al registrarlo, con la tasa de ese día, y queda guardado
 * (`applied_usd`) para que el saldo no cambie cuando cambia la tasa.
 *
 * Un cargo no es una factura fiscal. Es lo que se debe por un periodo.
 *
 * Toda escritura deja su apunte en `operator_audit` dentro de la misma
 * transacción: si no se puede dejar rastro, no se cambia nada.
 */

const CYCLES = ['MONTHLY', 'ANNUAL'];
const PAID_TIERS = ['STARTER', 'PRO', 'ENTERPRISE'];
const SUB_STATUSES = ['ACTIVE', 'SUSPENDED', 'CANCELLED'];
const METHODS = ['PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER'];

/** Días entre el inicio del periodo y el vencimiento del cargo. */
const DUE_DAYS = 5;

const iso = value => (value ? new Date(value).toISOString() : null);
const day = value => {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  // pg devuelve DATE como Date a medianoche local del proceso.
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const str = value => (value === null || value === undefined ? null : String(value));

/** Precio de la lista para un plan y ciclo en una fecha, o null. */
async function listPrice(client, tier, cycle, onDate) {
  const { rows } = await client.query(
    `SELECT amount_usd FROM plan_prices
      WHERE tier = $1 AND billing_cycle = $2 AND effective_from <= $3::DATE
      ORDER BY effective_from DESC LIMIT 1`,
    [tier, cycle, onDate]
  );
  return rows.length ? BigInt(rows[0].amount_usd) : null;
}

/** Lo que vale al mes, para sumar ingresos recurrentes: un anual se reparte en doce. */
function monthlyValue(price, cycle) {
  if (price === null) return null;
  return cycle === 'ANNUAL' ? money.divideRound(price, 12n) : price;
}

/**
 * En qué situación está un cliente, en una palabra.
 *
 * El orden importa: una suscripción cancelada o suspendida lo es aunque deba
 * dinero; una prueba es prueba aunque tenga un cargo abierto por error.
 */
function stateOf(row, today) {
  if (row.sub_status === 'CANCELLED') return 'CANCELLED';
  if (row.sub_status === 'SUSPENDED') return 'SUSPENDED';
  if (row.plan_tier === 'TRIAL') {
    return row.trial_ends_at && day(row.trial_ends_at) < today ? 'TRIAL_EXPIRED' : 'TRIAL';
  }
  if (row.overdue) return 'OVERDUE';
  return 'ACTIVE';
}

const CLIENT_SQL = `
  SELECT r.id, r.name, r.rif, r.plan_tier, r.trial_ends_at, r.created_at,
         COALESCE(s.status, 'ACTIVE') AS sub_status,
         COALESCE(s.billing_cycle, 'MONTHLY') AS billing_cycle,
         s.custom_price_usd, s.notes,
         (SELECT u.email FROM users u
           WHERE u.restaurant_id = r.id AND u.role = 'OWNER' AND u.active
           ORDER BY u.created_at LIMIT 1) AS owner_email,
         (SELECT max(b.created_at) FROM bills b WHERE b.restaurant_id = r.id) AS last_activity_at,
         (SELECT pp.amount_usd FROM plan_prices pp
           WHERE pp.tier = r.plan_tier AND pp.billing_cycle = COALESCE(s.billing_cycle, 'MONTHLY')
             AND pp.effective_from <= $1::DATE
           ORDER BY pp.effective_from DESC LIMIT 1) AS list_price_usd,
         (SELECT COALESCE(SUM(c.amount_usd - COALESCE(
                   (SELECT SUM(p.applied_usd) FROM subscription_payments p WHERE p.charge_id = c.id), 0)), 0)
            FROM subscription_charges c
           WHERE c.restaurant_id = r.id AND c.status = 'OPEN') AS balance_usd,
         EXISTS (SELECT 1 FROM subscription_charges c
                  WHERE c.restaurant_id = r.id AND c.status = 'OPEN' AND c.due_on < $1::DATE) AS overdue
    FROM restaurants r
    LEFT JOIN restaurant_subscriptions s ON s.restaurant_id = r.id`;

function clientView(row, today) {
  const custom = row.custom_price_usd === null ? null : BigInt(row.custom_price_usd);
  const list = row.list_price_usd === null ? null : BigInt(row.list_price_usd);
  const price = row.plan_tier === 'TRIAL' ? null : (custom ?? list);
  const balance = BigInt(row.balance_usd);
  return {
    id: row.id,
    name: row.name,
    rif: row.rif,
    ownerEmail: row.owner_email,
    tier: row.plan_tier,
    trialEndsAt: iso(row.trial_ends_at),
    state: stateOf(row, today),
    subscriptionStatus: row.sub_status,
    billingCycle: row.billing_cycle,
    customPriceUsd: str(custom),
    listPriceUsd: str(list),
    priceUsd: str(price),
    monthlyValueUsd: str(monthlyValue(price, row.billing_cycle)),
    balanceUsd: String(balance > 0n ? balance : 0n),
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.created_at),
    notes: row.notes ?? null
  };
}

/**
 * Todos los clientes, con lo que hace falta para decidir a quién llamar hoy.
 * Y un resumen: cuántos hay en cada situación y cuánto entra al mes.
 */
async function listClients({ q = null, state = null } = {}) {
  const today = fx.caracasToday();
  const { rows } = await db.query(
    `${CLIENT_SQL}
      WHERE $2::TEXT IS NULL
         OR r.name ILIKE '%' || $2::TEXT || '%'
         OR r.rif ILIKE '%' || $2::TEXT || '%'
         OR EXISTS (SELECT 1 FROM users u WHERE u.restaurant_id = r.id AND u.email ILIKE '%' || $2::TEXT || '%')
      ORDER BY r.name`,
    [today, q]
  );
  const all = rows.map(r => clientView(r, today));
  const counts = {};
  let mrr = 0n;
  let owed = 0n;
  for (const c of all) {
    counts[c.state] = (counts[c.state] || 0) + 1;
    if ((c.state === 'ACTIVE' || c.state === 'OVERDUE') && c.monthlyValueUsd) mrr += BigInt(c.monthlyValueUsd);
    owed += BigInt(c.balanceUsd);
  }
  return {
    data: state ? all.filter(c => c.state === state) : all,
    summary: {
      total: all.length,
      byState: counts,
      monthlyRecurringUsd: String(mrr),
      outstandingUsd: String(owed)
    }
  };
}

function chargeView(row) {
  const applied = BigInt(row.applied_usd ?? 0);
  const amount = BigInt(row.amount_usd);
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name ?? undefined,
    tier: row.tier,
    billingCycle: row.billing_cycle,
    periodStart: day(row.period_start),
    periodEnd: day(row.period_end),
    amountUsd: String(amount),
    paidUsd: String(applied),
    remainingUsd: String(row.status === 'OPEN' && amount > applied ? amount - applied : 0n),
    dueOn: day(row.due_on),
    status: row.status,
    overdue: row.status === 'OPEN' && day(row.due_on) < fx.caracasToday(),
    paidAt: iso(row.paid_at),
    voidReason: row.void_reason ?? null,
    createdAt: iso(row.created_at)
  };
}

function paymentView(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    chargeId: row.charge_id,
    method: row.method,
    currency: row.currency,
    amount: String(row.amount),
    fxRate: row.fx_rate === null ? null : String(row.fx_rate),
    appliedUsd: String(row.applied_usd),
    reference: row.reference,
    receivedOn: day(row.received_on),
    notes: row.notes ?? null,
    recordedBy: row.recorded_by_email ?? null,
    createdAt: iso(row.created_at)
  };
}

const CHARGE_SQL = `
  SELECT c.*, r.name AS restaurant_name,
         (SELECT COALESCE(SUM(p.applied_usd), 0) FROM subscription_payments p WHERE p.charge_id = c.id) AS applied_usd
    FROM subscription_charges c
    JOIN restaurants r ON r.id = c.restaurant_id`;

/** La ficha de un cliente: situación, cobros, uso y lo que falta por configurar. */
async function getClient(restaurantId) {
  const today = fx.caracasToday();
  const { rows } = await db.query(`${CLIENT_SQL} WHERE r.id = $2`, [today, restaurantId]);
  if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
  const client = clientView(rows[0], today);

  const [charges, payments, usage, history] = await Promise.all([
    db.query(`${CHARGE_SQL} WHERE c.restaurant_id = $1 ORDER BY c.period_start DESC`, [restaurantId]),
    db.query(
      `SELECT p.*, o.email AS recorded_by_email
         FROM subscription_payments p
         LEFT JOIN platform_operators o ON o.id = p.recorded_by
        WHERE p.restaurant_id = $1 ORDER BY p.received_on DESC, p.created_at DESC`,
      [restaurantId]
    ),
    db.query(
      `SELECT
         (SELECT count(*)::INT FROM bills b
           WHERE b.restaurant_id = $1 AND b.created_at > NOW() - INTERVAL '30 days') AS bills_30d,
         (SELECT COALESCE(SUM(p.amount_ves), 0) FROM payments p
           WHERE p.restaurant_id = $1 AND p.status = 'SUCCEEDED'
             AND p.created_at > NOW() - INTERVAL '30 days') AS collected_ves_30d,
         (SELECT count(*)::INT FROM tables t WHERE t.restaurant_id = $1) AS tables,
         (SELECT count(*)::INT FROM users u WHERE u.restaurant_id = $1 AND u.active) AS staff,
         (SELECT count(*)::INT FROM menu_products m WHERE m.restaurant_id = $1) AS products,
         (SELECT count(*)::INT FROM bank_connections k WHERE k.restaurant_id = $1 AND k.active) AS bank_connections`,
      [restaurantId]
    ),
    db.query(
      `SELECT a.action, a.details, a.created_at, o.email AS operator_email
         FROM operator_audit a
         LEFT JOIN platform_operators o ON o.id = a.operator_id
        WHERE a.restaurant_id = $1
        ORDER BY a.created_at DESC LIMIT 50`,
      [restaurantId]
    )
  ]);

  const u = usage.rows[0];
  return {
    client,
    charges: charges.rows.map(chargeView),
    payments: payments.rows.map(paymentView),
    usage: {
      bills30d: u.bills_30d,
      collectedVes30d: String(u.collected_ves_30d),
      tables: u.tables,
      staff: u.staff,
      products: u.products,
      bankConnections: u.bank_connections
    },
    setup: {
      menuLoaded: u.products > 0,
      tablesCreated: u.tables > 0,
      rifSet: Boolean(client.rif),
      bankConnected: u.bank_connections > 0
    },
    history: history.rows.map(h => ({
      action: h.action,
      details: h.details,
      operatorEmail: h.operator_email,
      at: iso(h.created_at)
    }))
  };
}

async function changePlan({ operator, restaurantId, tier, trialDays = null, force = false, note = null, meta = {} }) {
  const result = await plans.change({ restaurantId, tier, trialDays, force, note, operator, meta });
  return result;
}

/** Ciclo, precio pactado, estado y notas. Lo que no se manda, no cambia. */
async function updateSubscription({ operator, restaurantId, changes, meta = {} }) {
  return db.withTransaction(async client => {
    const { rows: r } = await client.query('SELECT id FROM restaurants WHERE id = $1 FOR UPDATE', [restaurantId]);
    if (!r.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
    const { rows: prev } = await client.query(
      'SELECT * FROM restaurant_subscriptions WHERE restaurant_id = $1', [restaurantId]
    );
    const before = prev[0] || { billing_cycle: 'MONTHLY', custom_price_usd: null, status: 'ACTIVE', notes: null };
    const next = {
      billing_cycle: changes.billingCycle ?? before.billing_cycle,
      custom_price_usd: changes.customPriceUsd === undefined ? before.custom_price_usd : changes.customPriceUsd,
      status: changes.status ?? before.status,
      notes: changes.notes === undefined ? before.notes : changes.notes
    };
    await client.query(
      `INSERT INTO restaurant_subscriptions (restaurant_id, billing_cycle, custom_price_usd, status, notes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (restaurant_id) DO UPDATE
         SET billing_cycle = EXCLUDED.billing_cycle, custom_price_usd = EXCLUDED.custom_price_usd,
             status = EXCLUDED.status, notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by,
             updated_at = NOW()`,
      [restaurantId, next.billing_cycle, next.custom_price_usd, next.status, next.notes, operator.id]
    );
    await operators.audit(client, {
      operatorId: operator.id, action: 'SUBSCRIPTION_UPDATED', restaurantId,
      resourceType: 'restaurant', resourceId: restaurantId,
      details: {
        before: { billingCycle: before.billing_cycle, customPriceUsd: str(before.custom_price_usd), status: before.status },
        after: { billingCycle: next.billing_cycle, customPriceUsd: str(next.custom_price_usd), status: next.status },
        reason: changes.reason ?? null
      },
      meta
    });
  }).then(() => getClient(restaurantId));
}

function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // El mismo día del mes, o el último si ese mes es más corto (31 de enero -> 28 de febrero).
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const t = new Date(`${isoDate}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

/**
 * El cargo del periodo siguiente.
 *
 * Sin fecha, empieza donde terminó el último cargo vivo, o hoy si es el
 * primero. El importe es el precio pactado o, si no hay, el de la lista para su
 * plan y ciclo en la fecha de inicio. Un restaurante en prueba no tiene precio
 * de lista, así que no se le cobra por accidente.
 */
async function createCharge({ operator = null, restaurantId, periodStart = null, meta = {}, via = 'console' }) {
  const today = fx.caracasToday();
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `SELECT r.id, r.plan_tier, COALESCE(s.billing_cycle, 'MONTHLY') AS billing_cycle, s.custom_price_usd
         FROM restaurants r LEFT JOIN restaurant_subscriptions s ON s.restaurant_id = r.id
        WHERE r.id = $1 FOR UPDATE OF r`,
      [restaurantId]
    );
    if (!rows.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');
    const r = rows[0];

    let start = periodStart;
    if (!start) {
      const { rows: last } = await client.query(
        `SELECT period_end FROM subscription_charges
          WHERE restaurant_id = $1 AND status <> 'VOID' ORDER BY period_end DESC LIMIT 1`,
        [restaurantId]
      );
      start = last.length ? day(last[0].period_end) : today;
    }
    const end = addMonths(start, r.billing_cycle === 'ANNUAL' ? 12 : 1);

    const amount = r.custom_price_usd !== null
      ? BigInt(r.custom_price_usd)
      : (PAID_TIERS.includes(r.plan_tier) ? await listPrice(client, r.plan_tier, r.billing_cycle, start) : null);
    if (!amount || amount <= 0n) {
      throw new ApiError('SUBSCRIPTION_PRICE_MISSING',
        'There is no price for this plan and cycle, and no agreed price for this restaurant',
        { tier: r.plan_tier, billingCycle: r.billing_cycle });
    }

    let inserted;
    try {
      ({ rows: inserted } = await client.query(
        `INSERT INTO subscription_charges
           (restaurant_id, tier, billing_cycle, period_start, period_end, amount_usd, due_on, created_by)
         VALUES ($1, $2, $3, $4::DATE, $5::DATE, $6, $7::DATE, $8)
         RETURNING *, 0 AS applied_usd`,
        [restaurantId, r.plan_tier, r.billing_cycle, start, end, String(amount), addDays(start, DUE_DAYS), operator ? operator.id : null]
      ));
    } catch (err) {
      if (err.code === '23505') {
        throw new ApiError('SUBSCRIPTION_CHARGE_EXISTS', 'That period already has a charge', { periodStart: start });
      }
      throw err;
    }
    await operators.audit(client, {
      operatorId: operator ? operator.id : null, action: 'CHARGE_CREATED', restaurantId,
      resourceType: 'subscription_charge', resourceId: inserted[0].id,
      details: { periodStart: start, periodEnd: end, amountUsd: String(amount), tier: r.plan_tier, via }, meta
    });
    return chargeView(inserted[0]);
  });
}

async function lockCharge(client, chargeId) {
  const { rows } = await client.query(
    `SELECT c.*, (SELECT COALESCE(SUM(p.applied_usd), 0) FROM subscription_payments p WHERE p.charge_id = c.id) AS applied_usd
       FROM subscription_charges c WHERE c.id = $1 FOR UPDATE OF c`,
    [chargeId]
  );
  if (!rows.length) throw new ApiError('SUBSCRIPTION_CHARGE_NOT_FOUND', 'Charge not found');
  return rows[0];
}

/** Anular un cargo mal hecho. Con pagos aplicados no se anula: primero hay que saber adónde van. */
async function voidCharge({ operator, chargeId, reason, meta = {} }) {
  return db.withTransaction(async client => {
    const c = await lockCharge(client, chargeId);
    if (c.status !== 'OPEN' || BigInt(c.applied_usd) > 0n) {
      throw new ApiError('SUBSCRIPTION_CHARGE_CLOSED',
        c.status !== 'OPEN' ? 'Only an open charge can be voided' : 'This charge already has payments applied',
        { status: c.status });
    }
    const { rows } = await client.query(
      `UPDATE subscription_charges SET status = 'VOID', void_reason = $2, updated_at = NOW()
        WHERE id = $1 RETURNING *, 0 AS applied_usd`,
      [chargeId, reason]
    );
    await operators.audit(client, {
      operatorId: operator.id, action: 'CHARGE_VOIDED', restaurantId: c.restaurant_id,
      resourceType: 'subscription_charge', resourceId: chargeId, details: { reason }, meta
    });
    return chargeView(rows[0]);
  });
}

/** La tasa del BCV de hoy, o un error que pide mandarla: nunca se inventa. */
async function todaysRate() {
  const today = await fx.getRateFor('USD');
  if (!today) {
    throw new ApiError('VALIDATION_FAILED', 'Send fxRate: there is no BCV rate available today', { fieldPaths: ['fxRate'] });
  }
  return String(today.rate);
}

/**
 * Registrar un pago recibido.
 *
 * En bolívares hace falta la tasa (si no se manda, la del BCV de hoy): con ella
 * se fija cuánto descuenta del cargo, y eso ya no cambia. Si el pago cubre lo
 * que falta, el cargo queda pagado. `settle` lo da por pagado aunque falten
 * céntimos -- una diferencia de redondeo en la transferencia --, y queda dicho
 * en el rastro.
 */
async function recordPayment({ operator, restaurantId, input, meta = {} }) {
  const prepared = await preparePayment(input);
  return db.withTransaction(client => recordPaymentWith(client, { operator, restaurantId, input, prepared, meta }));
}

/** Importe en céntimos, tasa y lo que descuenta en dólares. Fuera de la transacción: puede ir al BCV. */
async function preparePayment(input) {
  const { currency, amount } = input;
  const rateText = currency === 'VES' ? (input.fxRate || await todaysRate()) : null;
  const amountMinor = money.toMinor(amount, 'Amount');
  const applied = currency === 'USD'
    ? amountMinor
    : money.divideByRate(amountMinor, money.parseRate(rateText), 'Applied amount');
  return { rateText, amountMinor, applied };
}

/**
 * El registro del pago, dentro de una transacción ajena. Lo usa también la
 * confirmación de un aviso de «Ya pagué», que tiene que marcar el aviso y
 * registrar el pago juntos o ninguna de las dos cosas.
 */
async function recordPaymentWith(client, { operator, restaurantId, input, prepared, meta = {} }) {
  const { chargeId = null, method, currency, reference = null, receivedOn, notes = null, settle = false } = input;
  const { rateText, amountMinor, applied } = prepared;

  const { rows: r } = await client.query('SELECT id FROM restaurants WHERE id = $1', [restaurantId]);
  if (!r.length) throw new ApiError('RESTAURANT_NOT_FOUND', 'Restaurant not found');

  let charge = null;
  if (chargeId) {
    charge = await lockCharge(client, chargeId);
    if (charge.restaurant_id !== restaurantId) {
      throw new ApiError('SUBSCRIPTION_CHARGE_NOT_FOUND', 'Charge not found');
    }
    if (charge.status !== 'OPEN') {
      throw new ApiError('SUBSCRIPTION_CHARGE_CLOSED', 'This charge is already closed', { status: charge.status });
    }
  }

  const { rows: inserted } = await client.query(
    `INSERT INTO subscription_payments
       (restaurant_id, charge_id, method, currency, amount, fx_rate, applied_usd, reference,
        received_on, notes, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::DATE, $10, $11)
     RETURNING *`,
    [restaurantId, chargeId, method, currency, String(amountMinor),
      currency === 'VES' ? rateText : null, String(applied), reference, receivedOn, notes, operator.id]
  );

  let closed = false;
  if (charge) {
    const paid = BigInt(charge.applied_usd) + applied;
    if (paid >= BigInt(charge.amount_usd) || settle) {
      await client.query(
        `UPDATE subscription_charges SET status = 'PAID', paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [charge.id]
      );
      closed = true;
    }
  }

  await operators.audit(client, {
    operatorId: operator.id, action: 'PAYMENT_RECORDED', restaurantId,
    resourceType: 'subscription_payment', resourceId: inserted[0].id,
    details: {
      chargeId, method, currency, amount: String(amountMinor), fxRate: currency === 'VES' ? rateText : null,
      appliedUsd: String(applied), closedCharge: closed,
      settledShort: closed && settle && BigInt(charge.applied_usd) + applied < BigInt(charge.amount_usd)
    },
    meta
  });

  const payment = paymentView({ ...inserted[0], recorded_by_email: operator.email });
  const chargeAfter = charge ? chargeView(await lockCharge(client, charge.id)) : null;
  return { payment, charge: chargeAfter };
}

/** Los cargos de todos los clientes. OVERDUE es un filtro, no un estado guardado. */
async function listCharges({ status = null } = {}) {
  let clause = '';
  const params = [];
  if (status === 'OVERDUE') {
    params.push(fx.caracasToday());
    clause = `WHERE c.status = 'OPEN' AND c.due_on < $1::DATE`;
  } else if (status) {
    params.push(status);
    clause = 'WHERE c.status = $1';
  }
  const { rows } = await db.query(`${CHARGE_SQL} ${clause} ORDER BY c.due_on DESC, r.name LIMIT 500`, params);
  return rows.map(chargeView);
}

function priceView(row) {
  return {
    id: row.id,
    tier: row.tier,
    billingCycle: row.billing_cycle,
    amountUsd: String(row.amount_usd),
    effectiveFrom: day(row.effective_from),
    createdAt: iso(row.created_at)
  };
}

/** La lista de precios completa y, aparte, la que rige hoy. */
async function listPrices() {
  const today = fx.caracasToday();
  const { rows } = await db.query('SELECT * FROM plan_prices ORDER BY tier, billing_cycle, effective_from DESC');
  const current = [];
  for (const tier of PAID_TIERS) {
    for (const cycle of CYCLES) {
      const row = rows.find(p => p.tier === tier && p.billing_cycle === cycle && day(p.effective_from) <= today);
      if (row) current.push(priceView(row));
    }
  }
  return { current, history: rows.map(priceView) };
}

async function addPrice({ operator, tier, billingCycle, amountUsd, effectiveFrom = null, meta = {} }) {
  const from = effectiveFrom || fx.caracasToday();
  const amount = money.toMinor(amountUsd, 'Price');
  if (amount <= 0n) throw new ApiError('VALIDATION_FAILED', 'Price must be positive', { fieldPaths: ['amountUsd'] });
  return db.withTransaction(async client => {
    const { rows } = await client.query(
      `INSERT INTO plan_prices (tier, billing_cycle, amount_usd, effective_from, created_by)
       VALUES ($1, $2, $3, $4::DATE, $5)
       ON CONFLICT (tier, billing_cycle, effective_from) DO UPDATE
         SET amount_usd = EXCLUDED.amount_usd, created_by = EXCLUDED.created_by, created_at = NOW()
       RETURNING *`,
      [tier, billingCycle, String(amount), from, operator.id]
    );
    await operators.audit(client, {
      operatorId: operator.id, action: 'PRICE_SET', resourceType: 'plan_price', resourceId: rows[0].id,
      details: { tier, billingCycle, amountUsd: String(amount), effectiveFrom: from }, meta
    });
    return priceView(rows[0]);
  });
}

module.exports = {
  CYCLES, PAID_TIERS, SUB_STATUSES, METHODS, DUE_DAYS,
  listClients, getClient, changePlan, updateSubscription,
  createCharge, voidCharge, recordPayment, preparePayment, recordPaymentWith, listCharges,
  CLIENT_SQL, clientView, chargeView, lockCharge, addMonths, addDays,
  listPrices, addPrice,
  _internals: { addMonths, addDays, stateOf, monthlyValue, day }
};

// Evita que un plan desconocido se cuele en la lista de precios por otra vía.
if (PAID_TIERS.some(t => !entitlements.TIERS.includes(t))) {
  throw new Error('platformBilling: PAID_TIERS out of sync with entitlements.TIERS');
}
