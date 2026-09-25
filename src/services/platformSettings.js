const db = require('../connectors/base');
const operators = require('./operators');

/**
 * Ajustes de la plataforma que el equipo cambia desde la consola.
 *
 * Hoy uno solo: a dónde le pagan los restaurantes a Splite. Se enseña en el
 * panel de cada restaurante («Tu suscripción») y en los recordatorios. Son
 * datos que Splite quiere que se vean -- no hay nada secreto aquí.
 */

const PAYMENT_DETAILS = 'payment_details';

const EMPTY = {
  holder: null, idNumber: null, bankName: null, bankCode: null,
  phone: null, accountNumber: null, zelle: null, notes: null
};

async function getPaymentDetails() {
  const { rows } = await db.query('SELECT value FROM platform_settings WHERE key = $1', [PAYMENT_DETAILS]);
  return { ...EMPTY, ...(rows[0]?.value || {}) };
}

/** Si no hay a dónde pagar, no tiene sentido pedir que paguen. */
function hasPaymentDetails(d) {
  return Boolean(d.phone && d.idNumber && d.bankCode) || Boolean(d.accountNumber) || Boolean(d.zelle);
}

async function setPaymentDetails({ operator, details, meta = {} }) {
  const value = { ...EMPTY };
  for (const k of Object.keys(EMPTY)) value[k] = details[k] ? String(details[k]).trim() : null;
  return db.withTransaction(async client => {
    await client.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [PAYMENT_DETAILS, JSON.stringify(value), operator.id]
    );
    await operators.audit(client, {
      operatorId: operator.id, action: 'PAYMENT_DETAILS_SET', resourceType: 'platform_setting',
      details: value, meta
    });
    return value;
  });
}

module.exports = { getPaymentDetails, setPaymentDetails, hasPaymentDetails, EMPTY };
