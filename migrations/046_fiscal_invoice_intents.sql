-- «Envíame la factura», dicho al avisar del pago y cumplido al confirmarlo.
--
-- La factura sólo se puede emitir sobre un cobro confirmado, y confirmar un
-- Pago Móvil lo hace una persona del local cuando encuentra la transferencia en
-- su banco: minutos después, a veces con el comensal ya en la calle. Hasta aquí
-- la única forma de pedirla era quedarse mirando la pantalla hasta que llegara
-- esa confirmación, y el correo que el comensal dejaba al avisar del pago se
-- guardaba como contacto y no llegaba nunca a la factura.
--
-- Esto guarda la petición junto al aviso para cumplirla en el momento en que
-- se pueda. **No es una factura ni la reserva**: no gasta número de control ni
-- escribe nada fiscal. Si el cobro se rechaza, la petición se queda sin
-- cumplir y no pasa nada más.
--
-- Una tabla propia y no columnas de `payments` porque su vida es otra: los
-- pagos tienen transiciones con disparador y registro sólo de añadir, y esto
-- es una intención que cambia de estado una vez y guarda datos personales que
-- nada de `payments` tiene por qué llevar.

BEGIN;

CREATE TABLE IF NOT EXISTS fiscal_invoice_intents (
  -- Una por cobro: el mismo índice que impide dos facturas del mismo pago
  -- (`fiscal_requests_payment_idx`) impediría cumplir la segunda de todos modos.
  payment_id UUID PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Adónde mandarla. Obligatorio: pedir la factura por correo sin correo no es
  -- una petición, y sin él no hay a quién entregarla.
  email VARCHAR(255) NOT NULL,
  -- A nombre de quién. Los dos vacíos es consumidor final, que es el caso
  -- normal.
  customer_name VARCHAR(160),
  customer_tax_id VARCHAR(20),

  -- WAITING  el cobro todavía no está confirmado.
  -- ISSUED   la factura salió y su entrega quedó en la cola de correo.
  -- FAILED   se intentó al confirmar y no se pudo. `last_error_code` dice por
  --          qué; el comensal todavía puede pedirla a mano desde su pantalla.
  -- SKIPPED  no hacía falta: la factura de este cobro ya existía, pedida a mano
  --          mientras tanto.
  status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
  last_error_code VARCHAR(80),

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,

  CONSTRAINT fiscal_intents_status_check
    CHECK (status IN ('WAITING', 'ISSUED', 'FAILED', 'SKIPPED')),
  -- Resuelta y sin fecha no sirve para contestar «¿cuándo salió?».
  CONSTRAINT fiscal_intents_resolved_check
    CHECK ((status = 'WAITING') = (resolved_at IS NULL))
);

CREATE INDEX IF NOT EXISTS fiscal_intents_restaurant_idx
  ON fiscal_invoice_intents (restaurant_id, status);

COMMIT;
