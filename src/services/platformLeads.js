const config = require('../config');
const db = require('../connectors/base');
const { ApiError } = require('../errors');
const onboarding = require('./onboarding');
const operators = require('./operators');

/**
 * Las solicitudes de «Quiero Splite», en la consola.
 *
 * Las mismas funciones que usa `npm run onboarding`: la consola no reimplementa
 * la regla, sólo la pone a mano del equipo y deja su rastro con nombre.
 */

const iso = v => (v ? new Date(v).toISOString() : null);

function leadView(row) {
  return {
    id: row.id,
    restaurantName: row.restaurant_name,
    rif: row.rif,
    email: row.email,
    phone: row.phone,
    status: row.status,
    rifChecksumOk: row.rif_checksum_ok ?? null,
    createdAt: iso(row.created_at),
    invitedAt: iso(row.invited_at),
    consumedAt: iso(row.consumed_at)
  };
}

async function listLeads({ status = null } = {}) {
  const rows = await onboarding.listLeads({ status, limit: 200 });
  return rows.map(leadView).reverse();
}

async function audit(action, { operator, leadId, details = null, meta = {} }) {
  await operators.audit(db, {
    operatorId: operator.id, action, resourceType: 'restaurant_signup', resourceId: leadId, details, meta
  });
}

async function markLead({ operator, leadId, status, notes = null, meta = {} }) {
  try {
    const row = await onboarding.markLead(leadId, status, notes);
    await audit(status === 'CONTACTED' ? 'LEAD_CONTACTED' : 'LEAD_REJECTED', { operator, leadId, details: { notes }, meta });
    return row;
  } catch (err) {
    if (err.code === 'NOT_FOUND') throw new ApiError('LEAD_NOT_FOUND', 'Lead not found');
    throw err;
  }
}

/**
 * Mandar el enlace de alta. Sólo con el alta por enlace encendida: sin ella la
 * página que lo recibe no existe y el correo llevaría a un 404.
 */
async function inviteLead({ operator, leadId, meta = {} }) {
  if (!config.onboarding.enabled) {
    throw new ApiError('ONBOARDING_DISABLED', 'Self-service onboarding is off (ONBOARDING_ENABLED)');
  }
  try {
    const result = await onboarding.inviteLead(leadId, meta);
    await audit('LEAD_INVITED', { operator, leadId, details: { email: result.email }, meta });
    return result;
  } catch (err) {
    if (err.code === 'NOT_FOUND') throw new ApiError('LEAD_NOT_FOUND', err.message);
    throw err;
  }
}

module.exports = { listLeads, markLead, inviteLead, leadView };
