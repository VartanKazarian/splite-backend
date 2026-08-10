const db = require('../connectors/base');
const { logger } = require('../connectors/logger');

/**
 * Audit writes are best-effort: an audit failure must never fail the business
 * operation, but it must be loud in the logs.
 */
async function logAudit({
  action,
  restaurantId = null,
  actorId = null,
  resourceType = null,
  resourceId = null,
  ip = null,
  userAgent = null,
  requestId = null,
  details = null
} = {}) {
  try {
    await db.query(
      `INSERT INTO audit_logs
         (restaurant_id, actor_id, action, resource_type, resource_id, ip, user_agent, request_id, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        restaurantId,
        actorId,
        action,
        resourceType,
        resourceId,
        ip,
        userAgent ? String(userAgent).slice(0, 512) : null,
        requestId,
        details ? JSON.stringify(details) : null
      ]
    );
  } catch (err) {
    logger.error({ event: 'AUDIT_WRITE_FAILED', auditAction: action, err }, 'Audit write failed');
  }
}

/** Pulls actor/tenant/IP context off the request so call sites stay short. */
function auditContext(req) {
  return {
    restaurantId: req.user?.restaurantId ?? null,
    actorId: req.user?.sub ?? null,
    ip: req.ip ?? null,
    userAgent: req.get?.('user-agent') ?? null,
    requestId: req.id ?? null
  };
}

module.exports = { logAudit, auditContext };
