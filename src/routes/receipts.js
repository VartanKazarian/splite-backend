const express = require('express');
const { validateParams, receiptLinkParamSchema } = require('../middleware/schemas');
const rateLimit = require('../middleware/rateLimit');
const receipts = require('../services/receipts');
const { verifyReceiptLink } = require('../utils/tokens');
const { ApiError } = require('../errors');

/**
 * Un recibo abierto desde el enlace que el comensal se mandó por WhatsApp (R20).
 *
 * Sin sesión: el enlace firmado es el permiso (`utils/tokens.signReceiptLink`).
 * Es el mismo recibo que ve el teléfono, con una diferencia: la referencia
 * bancaria va recortada a sus cuatro últimas cifras. Un enlace se reenvía y se
 * queda en chats; la referencia entera no tiene por qué ir con él.
 *
 * Un enlace falsificado, roto o caducado contesta lo mismo que un pago que no
 * existe -- 404 --, para no enseñar cuál de las tres cosas falló.
 */
const router = express.Router();

router.get(
  '/:token',
  rateLimit({ windowSeconds: 60, max: 30, keyPrefix: 'receipt-link' }),
  validateParams(receiptLinkParamSchema),
  async (req, res, next) => {
    try {
      const link = verifyReceiptLink(req.params.token);
      if (!link) throw new ApiError('RECEIPT_LINK_INVALID', 'This receipt link is not valid');
      let receipt;
      try {
        receipt = await receipts.forPayment({ restaurantId: link.restaurantId, paymentId: link.paymentId });
      } catch (err) {
        if (err instanceof ApiError) throw new ApiError('RECEIPT_LINK_INVALID', 'This receipt link is not valid');
        throw err;
      }
      const reference = receipt.payment?.reference;
      res.json({
        ...receipt,
        payment: {
          ...receipt.payment,
          reference: reference ? `…${String(reference).slice(-4)}` : null
        }
      });
    } catch (err) { next(err); }
  }
);

module.exports = router;
