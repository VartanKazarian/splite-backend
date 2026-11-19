/** Opening a bill -- empty or with a first order -- and changing who serves it. */
const express = require('express');
const db = require('../../connectors/base');
const config = require('../../config');
const { requireRole } = require('../../middleware/auth');
const { assertMayOpenBills } = require('../../services/subscriptionGate');
const {
  validateBody,
  validateParams,
  createBillSchema,
  orderSchema,
  billIdParamSchema,
  setBillServerSchema,
  tableIdParamSchema
} = require('../../middleware/schemas');
const billItems = require('../../services/billItems');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const { snapshotFx } = require('../../services/billOpen');
const { logAudit, auditContext } = require('../../services/audit');
const { BILL_COLUMNS } = require('../../services/bills');

const router = express.Router();

router.post(
  '/',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateBody(createBillSchema),
  async (req, res, next) => {
    try {
      // Everything that can touch the network happens before BEGIN.
      //
      // snapshotFx may fetch from BCV, and this used to run inside the
      // transaction, after the table row was locked: an 8-second upstream
      // stalled every other request for that table, held a pooled connection,
      // and left the transaction idle long enough for
      // idle_in_transaction_session_timeout to terminate the session outright.
      //
      // Reading menu_currency outside the transaction means it could change
      // between here and the insert. That race is benign — the bill would use
      // a currency that was correct moments earlier — and changing it is
      // already refused while any active product disagrees.
      const restaurant = await db.query(
        'SELECT menu_currency, vat_bps, service_charge_bps FROM restaurants WHERE id = $1',
        [req.user.restaurantId]
      );
      const menuCurrency = restaurant.rows[0]?.menu_currency ?? 'VES';
      // Snapshotted onto the bill, like the FX rate and for the same reason:
      // changing a restaurant's rates must not reprice a meal already eaten.
      const vatBps = restaurant.rows[0]?.vat_bps ?? 0;
      const serviceChargeBps = restaurant.rows[0]?.service_charge_bps ?? 0;
      const fx = await snapshotFx(menuCurrency, req.body.totalDueMinorUnits);

      const created = await db.withTransaction(async client => {
        // The table row is locked for the duration, so two waiters opening a
        // bill for the same table serialise here instead of racing between the
        // check below and the insert.
        //
        // It is also resolved inside the caller's tenant, so a table id
        // belonging to another restaurant reads as 404 rather than creating a
        // bill that points across tenants.
        const table = await client.query(
          'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true FOR UPDATE',
          [req.body.tableId, req.user.restaurantId]
        );
        if (!table.rows.length) {
          throw new ApiError('TABLE_NOT_FOUND', 'Table not found');
        }

        const open = await client.query(
          "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
          [req.user.restaurantId, req.body.tableId]
        );
        if (open.rows.length) {
          throw new ApiError('OPEN_BILL_EXISTS', 'This table already has an open bill', {
            billId: open.rows[0].id
          });
        }
        await assertMayOpenBills(client, req.user.restaurantId);

        // The bill is denominated in whatever the menu quotes, at the rate
        // frozen above, before this transaction opened.
        const { rows } = await client.query(
          // subtotal_minor mirrors total_due here so the sum-of-parts check
          // holds for a bill opened with a fixed figure and no lines. Once it
          // is itemised, recalculateTotals owns all five columns.
          // served_by is whoever opened it. Right when the person taking the
          // order opens the bill, wrong when a host or cashier does it for
          // them -- which is why PATCH /bills/:id/server exists rather than
          // this being treated as the final word.
          `INSERT INTO bills (restaurant_id, table_id, total_due, subtotal_minor, currency,
                              vat_bps, service_charge_bps,
                              total_due_ves, fx_rate_ves_per_unit, fx_rate_source,
                              fx_value_date, fx_rate_as_of, served_by)
           VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), $11)
           RETURNING ${BILL_COLUMNS}`,
          [
            req.user.restaurantId, req.body.tableId, req.body.totalDueMinorUnits, menuCurrency,
            vatBps, serviceChargeBps,
            fx.totalDueVes, fx.rate, fx.source, fx.valueDate, req.user.sub
          ]
        );
        return rows[0];
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_CREATED',
        resourceType: 'bill',
        resourceId: created.id,
        details: {
          tableId: req.body.tableId,
          totalDue: created.total_due,
          currency: created.currency,
          totalDueVes: created.total_due_ves
        }
      });

      res.status(201).json(dto.bill(created));
    } catch (err) {
      // The partial unique index is the last line of defence: if a concurrent
      // request committed first, the insert fails here rather than producing a
      // second open bill for the table.
      if (err.code === '23505' && String(err.constraint || '').includes('one_open_per_table')) {
        return next(new ApiError('OPEN_BILL_EXISTS', 'This table already has an open bill'));
      }
      next(err);
    }
  }
);

/**
 * Takes an order for a table, opening its bill if there is not one yet.
 *
 * This is the shape of the job: a waiter has a table and a list of things, not
 * a bill id. Doing it with the primitives means asking whether a bill exists,
 * creating one if not, and then posting each line -- three or more calls, with
 * the client handling the not-yet-open case and able to leave half an order
 * behind if one of them fails.
 *
 * Everything that can touch the network happens before BEGIN, for the same
 * reason POST /bills does it: an FX lookup inside a transaction holds a row
 * lock across an 8-second upstream.
 */
router.post(
  '/tables/:tableId/order',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(tableIdParamSchema),
  validateBody(orderSchema),
  async (req, res, next) => {
    try {
      const restaurantId = req.user.restaurantId;

      // Read the open bill first: when one exists no rate is needed at all, and
      // the common case should not pay for a BCV round trip.
      const existing = await db.query(
        "SELECT id FROM bills WHERE restaurant_id = $1 AND table_id = $2 AND status = 'OPEN'",
        [restaurantId, req.params.tableId]
      );

      let fx = null;
      let menuCurrency = null;
      let vatBps = 0;
      let serviceChargeBps = 0;
      if (!existing.rows.length) {
        const restaurant = await db.query(
          'SELECT menu_currency, vat_bps, service_charge_bps FROM restaurants WHERE id = $1',
          [restaurantId]
        );
        menuCurrency = restaurant.rows[0]?.menu_currency ?? 'VES';
        vatBps = restaurant.rows[0]?.vat_bps ?? 0;
        serviceChargeBps = restaurant.rows[0]?.service_charge_bps ?? 0;
        fx = await snapshotFx(menuCurrency, '0');
      }

      const result = await db.withTransaction(async client => {
        const table = await client.query(
          'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2 AND active = true FOR UPDATE',
          [req.params.tableId, restaurantId]
        );
        if (!table.rows.length) throw new ApiError('TABLE_NOT_FOUND', 'Table not found');

        let opened = false;
        let billId = existing.rows[0]?.id;

        if (!billId) {
          await assertMayOpenBills(client, restaurantId);
          const created = await client.query(
            // Same rule as POST /bills: the person who opened it. This path is
            // the one a waiter actually uses -- they add the first order and
            // the bill appears -- so it is usually the accurate one.
            `INSERT INTO bills (restaurant_id, table_id, total_due, subtotal_minor, currency,
                                vat_bps, service_charge_bps,
                                total_due_ves, fx_rate_ves_per_unit, fx_rate_source,
                                fx_value_date, fx_rate_as_of, served_by)
             VALUES ($1, $2, 0, 0, $3, $4, $5, 0, $6, $7, $8, NOW(), $9)
             RETURNING id`,
            [restaurantId, req.params.tableId, menuCurrency, vatBps, serviceChargeBps,
              fx.rate, fx.source, fx.valueDate, req.user.sub]
          );
          billId = created.rows[0].id;
          opened = true;
        }

        // Locked here, so two waiters ordering for one table serialise rather
        // than both recomputing the total from a stale set of lines.
        const bill = await billItems.lockOpenBill(client, { restaurantId, billId });
        const { bill: updated } = await billItems.addItemsInTransaction(client, {
          restaurantId, bill, items: req.body.items
        });
        return { bill: updated, opened };
      }, { statementTimeoutMs: config.db.paymentStatementTimeoutMs });

      const items = await billItems.listForBill({ restaurantId, billId: result.bill.id });

      await logAudit({
        ...auditContext(req),
        action: result.opened ? 'BILL_OPENED_BY_ORDER' : 'ORDER_ADDED',
        resourceType: 'bill',
        resourceId: result.bill.id,
        details: { tableId: req.params.tableId, lines: req.body.items.length }
      });

      res.status(201).json({ opened: result.opened, bill: dto.billWithItems(result.bill, items) });
    } catch (err) { next(err); }
  }
);

/**
 * Correct who served a table, or claim a table nobody is down for.
 *
 * Two different acts behind one endpoint, with two different rules.
 *
 * **Correcting** is OWNER and MANAGER, and audited, because it moves money
 * between people: tips are attributed through the bill's *current* server, so a
 * correction here moves yesterday's tips with it. That is the point -- a
 * correction that left the money against the wrong name would not be one --
 * but it is also why a waiter cannot do it to their own tables. `servedBy:
 * null` clears it, for a bill that should not be attributed to anybody rather
 * than attributed wrongly.
 *
 * **Claiming** is anybody on staff, and only ever themselves, and only while
 * the bill has nobody. It takes nothing from anyone: an unattributed bill's
 * tips are in the "sin mesero" bucket, owed to nobody in particular, so moving
 * them to the person who actually served the table is the correction that
 * bucket exists to make possible.
 *
 * It exists because of the QR: a diner ordering from their phone opens the bill
 * with no server -- nobody from the house did -- and until somebody says
 * otherwise their tip belongs to nobody. The person who knows is the waiter who
 * walks over, and asking them to find a manager first is how a shift ends with
 * a pile of unattributed cash.
 *
 * The current server is read `FOR UPDATE` rather than checked in the WHERE, so
 * two waiters claiming the same table serialise and the second is told it is
 * taken instead of quietly overwriting the first.
 */
router.patch(
  '/:id/server',
  validateParams(billIdParamSchema),
  validateBody(setBillServerSchema),
  async (req, res, next) => {
    try {
      const restaurantId = req.user.restaurantId;
      const servedBy = req.body.servedBy ?? null;
      const canReassign = req.user.role === 'OWNER' || req.user.role === 'MANAGER';

      const updated = await db.withTransaction(async client => {
        // Checked rather than left to the foreign key, so the answer is
        // "no such person here" rather than a constraint name -- and so an
        // inactive account cannot quietly be given somebody's tips.
        if (servedBy) {
          const { rows } = await client.query(
            'SELECT id FROM users WHERE id = $1 AND restaurant_id = $2 AND active = true',
            [servedBy, restaurantId]
          );
          if (!rows.length) throw new ApiError('STAFF_NOT_FOUND', 'No such person at this restaurant');
        }

        if (!canReassign) {
          const current = await client.query(
            'SELECT served_by FROM bills WHERE id = $1 AND restaurant_id = $2 FOR UPDATE',
            [req.params.id, restaurantId]
          );
          if (!current.rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');

          // Sólo a sí mismo. Clearing it, or naming somebody else, is a
          // correction -- and a correction takes money off a name.
          if (servedBy !== req.user.sub) {
            throw new ApiError('FORBIDDEN_ROLE', 'Forbidden', {
              requiredRoles: ['OWNER', 'MANAGER']
            });
          }
          // Y sólo si no hay nadie. Claiming is filling a hole, never taking.
          if (current.rows[0].served_by && current.rows[0].served_by !== req.user.sub) {
            throw new ApiError('BILL_ALREADY_SERVED', 'This bill is already attributed', {
              servedBy: current.rows[0].served_by
            });
          }
        }

        const { rows } = await client.query(
          `UPDATE bills SET served_by = $3
            WHERE id = $1 AND restaurant_id = $2
            RETURNING ${BILL_COLUMNS}`,
          [req.params.id, restaurantId, servedBy]
        );
        if (!rows.length) throw new ApiError('BILL_NOT_FOUND', 'Bill not found');
        return rows[0];
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_SERVER_CHANGED',
        resourceType: 'bill',
        resourceId: updated.id,
        details: { servedBy }
      });

      res.json(dto.bill(updated));
    } catch (err) { next(err); }
  }
);

module.exports = router;
