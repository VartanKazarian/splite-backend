/** Splitting the bill from the diner's side. */
const express = require('express');
const {
  validateBody,
  validateParams,
  splitPreviewSchema,
  splitShareNameSchema,
  splitShareRefParamSchema
} = require('../../middleware/schemas');
const { authenticateGuest } = require('../../services/guest');
const billItems = require('../../services/billItems');
const splitEngine = require('../../services/splitEngine');
const splits = require('../../services/splits');
const dto = require('../../dto');
const { ApiError } = require('../../errors');
const { perSession, openBillForGuest } = require('./shared');

const router = express.Router();

/**
 * Agrees a persistent split of the guest's own bill.
 *
 * The diners at a table settle on who pays what and store it, so each can then
 * pay their own share -- by Pago Movil claim or C2P -- and no one can pay more
 * than their share. Takes no bill id, like every guest route: the table comes
 * from the session.
 */
router.post('/bill/splits', authenticateGuest, perSession, validateBody(splitPreviewSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const items = req.body.mode === 'ITEMS'
      ? await billItems.listForBill({ restaurantId: req.guest.restaurantId, billId: bill.id })
      : [];
    const split = await splits.createSplit({
      restaurantId: req.guest.restaurantId,
      bill, items, request: req.body,
      createdBy: { type: 'GUEST', id: null }
    });
    res.status(201).json(dto.billSplit(split));
  } catch (err) { next(err); }
});

/** The live split on the guest's bill, or 404. */
router.get('/bill/splits/active', authenticateGuest, perSession, async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const split = await splits.getActiveSplit({
      restaurantId: req.guest.restaurantId, billId: bill.id, bill, viewerSessionId: req.guest.sessionId
    });
    if (!split) throw new ApiError('SPLIT_NOT_FOUND', 'This bill has no active split');
    res.json(dto.billSplit(split));
  } catch (err) { next(err); }
});

/**
 * Quién es cada parte del reparto.
 *
 * El nombre se recogía sólo al crear el reparto, así que quien llegaba después
 * y tocaba una parte no daba el suyo nunca y la lista decía «Comensal 2». Esto
 * lo arregla donde está el problema: en la parte que el comensal acaba de
 * elegir.
 *
 * Lo escribe cualquiera con sesión en esa mesa -- el mismo permiso con el que
 * ya se crea y se reemplaza un reparto, porque la sesión es de la mesa y no de
 * la persona --, y deja de poder escribirse en cuanto esa parte ha recibido
 * dinero. Ver `splits.nameShare` para por qué.
 */
router.patch(
  '/bill/splits/active/participants/:ref',
  authenticateGuest,
  perSession,
  validateParams(splitShareRefParamSchema),
  validateBody(splitShareNameSchema),
  async (req, res, next) => {
    try {
      const bill = await openBillForGuest(req.guest);
      const split = await splits.nameShare({
        restaurantId: req.guest.restaurantId,
        billId: bill.id,
        ref: req.params.ref,
        name: req.body.name
      });
      res.json(dto.billSplit(split));
    } catch (err) { next(err); }
  }
);

/**
 * A split of the guest's own bill.
 *
 * The same engine the staff endpoint uses, so a diner and a waiter looking at
 * the same bill are never shown two different allocations. Advisory: it
 * computes and returns, and moves no money.
 */
router.post('/bill/split/preview', authenticateGuest, perSession, validateBody(splitPreviewSchema), async (req, res, next) => {
  try {
    const bill = await openBillForGuest(req.guest);
    const items = req.body.mode === 'ITEMS'
      ? await billItems.listForBill({ restaurantId: req.guest.restaurantId, billId: bill.id })
      : [];

    res.json(splitEngine.preview({ bill, items, request: req.body }));
  } catch (err) { next(err); }
});

module.exports = router;
