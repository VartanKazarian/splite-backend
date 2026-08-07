const db = require('../connectors/base');

async function logAudit(action, details) {
    try {
        await db.query(
            'INSERT INTO audit_logs (action, details) VALUES ($1, $2)',
            [action, JSON.stringify(details)]
        );
    } catch (err) {
        console.error('[Audit Log Error]', err.message);
    }
}

module.exports = { logAudit };
