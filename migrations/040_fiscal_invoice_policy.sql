-- Quién recibe la factura: cada comensal, o la mesa.
--
-- Son dos productos distintos y los dos son legítimos, así que se elige por
-- restaurante y no se impone:
--
--   PER_DINER    una factura fiscal por cada comensal que paga. Es lo que hace
--                falta cuando alguien tiene que justificar su propia cena --
--                una dieta, un gasto de empresa-- y es el caso que motivó todo
--                esto.
--
--   SINGLE_BILL  una sola factura fiscal por la cuenta entera. Los comensales
--                reciben su desglose, pero derivado de ese único documento y
--                sin ser documentos fiscales ellos mismos. Es terreno
--                regulatorio más firme -- una venta, una factura -- y es la
--                respuesta correcta para un local que no quiere emitir N
--                documentos por mesa.
--
-- Por defecto PER_DINER, que es lo que se pidió. Da igual para quien no tenga
-- la facturación activada, que son todos hasta que se conecte una imprenta
-- digital autorizada de verdad.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS fiscal_invoice_policy VARCHAR(20) NOT NULL DEFAULT 'PER_DINER';

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_fiscal_policy_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_fiscal_policy_check
  CHECK (fiscal_invoice_policy IN ('PER_DINER', 'SINGLE_BILL'));

COMMENT ON COLUMN restaurants.fiscal_invoice_policy IS
  'PER_DINER: una factura fiscal por comensal que paga. SINGLE_BILL: una sola '
  'por la cuenta, y los desgloses por comensal se derivan de ella sin ser '
  'documentos fiscales.';

-- En SINGLE_BILL la factura es de la cuenta y no de un cobro, así que va sin
-- `payment_id`. Ese caso necesita su propia unicidad: sin esto, el índice por
-- pago no dice nada (todos serían NULL) y una mesa podría acabar con dos
-- facturas por el total.
--
-- Sólo alcanza a las facturas: una nota de crédito sobre la misma cuenta es
-- justo lo que tiene que poder existir después.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_requests_bill_single_idx
  ON fiscal_invoice_requests (bill_id)
  WHERE payment_id IS NULL AND document_type = 'INVOICE' AND status <> 'FAILED';

COMMIT;
