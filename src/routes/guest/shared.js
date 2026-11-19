/** What more than one part of /guest needs: the per-session limiter and how a guest's bill is found. */
const db = require('../../connectors/base');
const { verifyQrToken } = require('../../utils/tokens');
const rateLimit = require('../../middleware/rateLimit');
const guestBillBinding = require('../../services/guestBillBinding');
const { ApiError } = require('../../errors');

/**
 * The real guest limit, mounted after authenticateGuest so the bucket keys on
 * the session rather than the address.
 *
 * The app-level limiter on /api/v1/guest runs before any of this and can only
 * see an IP, which on the diner-facing surface identifies a carrier NAT rather
 * than a person: one bucket for every table in the room. One diner refreshing
 * hard is now throttled and the table next to them is not.
 */
// NOT 'guest:session': that is the prefix the sessions themselves are stored
// under, so the counter and the credential would be the same Redis key. INCR on
// a key holding JSON errors, the limiter treats that as its backend being
// unavailable and fails open, and per-session limiting silently does nothing.
const perSession = rateLimit({ windowSeconds: 60, max: 60, keyPrefix: 'guest:rl' });

/**
 * The table a QR token names, or an error.
 *
 * Shared by the two public routes that accept a printed code, because the
 * checks are the whole of its security and a second copy is a second place for
 * one of them to go missing: the HMAC, the tenant-scoped lookup, `active`, and
 * the nonce -- which is what makes a reprinted or rotated code stop working.
 *
 * Every failure is the same `QR_INVALID`. A code stuck to a table is read by
 * strangers, and distinguishing "no such table" from "wrong nonce" would answer
 * questions about a restaurant to somebody holding a photograph of its
 * furniture.
 */
async function tableForQr(qrToken) {
  let payload;
  try {
    payload = verifyQrToken(qrToken);
  } catch {
    throw new ApiError('QR_INVALID', 'Invalid table QR');
  }

  const { rows } = await db.query(
    `SELECT t.id, t.restaurant_id, t.name, t.qr_nonce, t.active,
            r.name AS restaurant_name, r.menu_currency, r.active AS restaurant_active,
            cover.checksum AS cover_checksum, logo.checksum AS logo_checksum
       FROM tables t
       JOIN restaurants r ON r.id = t.restaurant_id
       LEFT JOIN restaurant_images cover
         ON cover.restaurant_id = r.id AND cover.kind = 'COVER'
       LEFT JOIN restaurant_images logo
         ON logo.restaurant_id = r.id AND logo.kind = 'LOGO'
      WHERE t.id = $1 AND t.restaurant_id = $2`,
    [payload.tableId, payload.restaurantId]
  );
  const table = rows[0];
  if (!table || !table.active || !table.restaurant_active ||
      String(table.qr_nonce) !== String(payload.nonce)) {
    throw new ApiError('QR_INVALID', 'Invalid table QR');
  }
  return table;
}

/**
 * The open bill for the guest's own table.
 *
 * Note what this route does not take: a bill id. The table comes from the
 * session, which came from a signed QR, so a guest cannot ask for a bill that
 * is not theirs -- there is no identifier to tamper with. Every guest route
 * below is built the same way.
 */
async function openBillForGuest(guest) {
  // La cuenta de esta sesión, no «la abierta de la mesa»: ver
  // services/guestBillBinding.js. `reason` dice a la pantalla si hay que
  // volver a escanear (la cuenta de esta sesión ya terminó).
  const { billId, reason } = await guestBillBinding.billForSession({
    restaurantId: guest.restaurantId, tableId: guest.tableId, sessionId: guest.sessionId
  });
  if (!billId) {
    throw new ApiError('OPEN_BILL_NOT_FOUND', 'No open bill for this session', { reason });
  }
  const { rows } = await db.query(
    `SELECT id, table_id, status, currency, total_due,
            subtotal_minor, vat_bps, vat_minor,
            service_charge_bps, service_charge_minor,
            total_due_ves, amount_paid_ves,
            fx_rate_ves_per_unit, updated_at
       FROM bills
      WHERE id = $1 AND restaurant_id = $2 AND status = 'OPEN'`,
    [billId, guest.restaurantId]
  );
  // Se cerró entre las dos lecturas.
  if (!rows.length) {
    throw new ApiError('OPEN_BILL_NOT_FOUND', 'No open bill for this session',
      { reason: guestBillBinding.REASONS.SESSION_BILL_ENDED });
  }
  return rows[0];
}

async function billForGuestPayment(guest, paymentId) {
  const { rows } = await db.query(
    `SELECT p.id AS payment_id, p.status AS payment_status, p.amount_ves, p.updated_at AS payment_updated_at,
            b.id AS bill_id, b.status AS bill_status,
            (SELECT i.id FROM fiscal_invoices i WHERE i.payment_id = p.id LIMIT 1) AS invoice_id,
            (SELECT i.control_number FROM fiscal_invoices i WHERE i.payment_id = p.id LIMIT 1)
              AS invoice_control_number,
            (SELECT i.customer_email FROM fiscal_invoices i WHERE i.payment_id = p.id LIMIT 1)
              AS invoice_email,
            fii.email AS intent_email, fii.status AS intent_status,
            -- Si aquí se factura o no. Va en esta consulta y no en otra porque
            -- el teléfono la repite cada ocho segundos mientras el cobro está
            -- por confirmar, y ya está filtrando por este restaurante.
            r.plan_tier, (fs.restaurant_id IS NOT NULL) AS has_series,
            (NULLIF(TRIM(r.rif), '') IS NOT NULL) AS has_rif
       FROM payments p
       JOIN bills b ON b.id = p.bill_id
       JOIN restaurants r ON r.id = p.restaurant_id
       LEFT JOIN fiscal_series fs ON fs.restaurant_id = r.id
       LEFT JOIN fiscal_invoice_intents fii ON fii.payment_id = p.id
      WHERE p.id = $1 AND p.restaurant_id = $2 AND b.table_id = $3
        -- Una sesión atada sólo ve pagos de su cuenta, abierta o cerrada: el
        -- recibo y la factura siguen al alcance cuando la cuenta se cierra,
        -- los de la siguiente cuenta de la mesa no.
        AND NOT EXISTS (
          SELECT 1 FROM guest_sessions s
           WHERE s.id = $4 AND s.bill_id IS NOT NULL AND s.bill_id <> b.id
        )`,
    [paymentId, guest.restaurantId, guest.tableId, guest.sessionId]
  );
  if (!rows.length) throw new ApiError('PAYMENT_NOT_FOUND', 'Payment not found');
  return rows[0];
}

module.exports = { perSession, tableForQr, openBillForGuest, billForGuestPayment };
