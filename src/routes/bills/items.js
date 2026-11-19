/** A bill's lines: add, change, remove. */
const express = require('express');
const { requireRole } = require('../../middleware/auth');
const {
  validateBody,
  validateParams,
  addBillItemSchema,
  updateBillItemSchema,
  billItemIdParamSchema,
  billIdParamSchema
} = require('../../middleware/schemas');
const billItems = require('../../services/billItems');
const dto = require('../../dto');
const { logAudit, auditContext } = require('../../services/audit');

const router = express.Router();

router.post(
  '/:id/items',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billIdParamSchema),
  validateBody(addBillItemSchema),
  async (req, res, next) => {
    try {
      const { item, bill } = await billItems.addItem({
        restaurantId: req.user.restaurantId,
        billId: req.params.id,
        productId: req.body.productId,
        quantity: req.body.quantity
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_ITEM_ADDED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { itemId: item.id, productId: req.body.productId, quantity: item.quantity }
      });

      res.status(201).json({ item: dto.billItem(item), bill: dto.bill(bill) });
    } catch (err) { next(err); }
  }
);

router.patch(
  '/:id/items/:itemId',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billItemIdParamSchema),
  validateBody(updateBillItemSchema),
  async (req, res, next) => {
    try {
      const { item, bill } = await billItems.updateQuantity({
        restaurantId: req.user.restaurantId,
        billId: req.params.id,
        itemId: req.params.itemId,
        quantity: req.body.quantity
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_ITEM_UPDATED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { itemId: item.id, quantity: item.quantity }
      });

      res.json({ item: dto.billItem(item), bill: dto.bill(bill) });
    } catch (err) { next(err); }
  }
);

router.delete(
  '/:id/items/:itemId',
  requireRole('OWNER', 'MANAGER', 'CASHIER', 'WAITER'),
  validateParams(billItemIdParamSchema),
  async (req, res, next) => {
    try {
      const { removedId, bill } = await billItems.removeItem({
        restaurantId: req.user.restaurantId,
        billId: req.params.id,
        itemId: req.params.itemId
      });

      await logAudit({
        ...auditContext(req),
        action: 'BILL_ITEM_REMOVED',
        resourceType: 'bill',
        resourceId: req.params.id,
        details: { itemId: removedId }
      });

      res.json({ removedId, bill: dto.bill(bill) });
    } catch (err) { next(err); }
  }
);

module.exports = router;
