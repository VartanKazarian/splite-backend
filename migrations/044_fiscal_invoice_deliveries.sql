-- Que la factura llegue al correo de quien la pidió.
--
-- Vive en su propia tabla y no en columnas de `fiscal_invoices` por una razón
-- que la 039 ya impone: la factura es **inmutable**, con un disparador que
-- rechaza UPDATE y DELETE. Un estado de envío es justo lo contrario -- cambia
-- de PENDING a SENT, cuenta intentos, guarda el último error --, así que
-- meterlo ahí obligaría a levantar la inmutabilidad de un registro legal para
-- mover un campo de progreso. Son dos cosas con vidas distintas.
--
-- Y el envío **no es parte del documento**. Una factura emitida es válida haya
-- llegado el correo o no; lo que falta cuando no llega es una entrega, no una
-- factura. Por eso un fallo aquí no puede tocar nada de la 039.

BEGIN;

CREATE TABLE IF NOT EXISTS fiscal_invoice_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT igual que en la factura: el rastro de a quién se le mandó su
  -- documento no puede desaparecer porque se borre otra cosa.
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  invoice_id    UUID NOT NULL REFERENCES fiscal_invoices(id) ON DELETE RESTRICT,

  -- La dirección de este envío, copiada y no leída de la factura. Un reenvío a
  -- un correo corregido es otra entrega, y la primera tiene que seguir
  -- contando adónde se mandó de verdad.
  email VARCHAR(255) NOT NULL,

  -- PENDING  creada y todavía sin salir, o con un intento que se perdió.
  -- SENT     el proveedor la aceptó. No es acuse de lectura ni de entrega.
  -- FAILED   se intentó y el proveedor dijo que no.
  --
  -- PENDING y FAILED son los dos reintentables, y se distinguen porque
  -- significan cosas distintas para quien mira: una que nunca llegó a salir es
  -- un proceso que se cortó, y una que falló es un problema con la dirección o
  -- con el proveedor.
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',

  attempts INTEGER NOT NULL DEFAULT 0,

  -- Recortado por la aplicación antes de escribir: el cuerpo de error de un
  -- proveedor puede devolver la dirección del destinatario, y esto se lee
  -- desde el panel.
  last_error TEXT,

  provider_message_id VARCHAR(200),
  sent_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fiscal_deliveries_status_check
    CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  CONSTRAINT fiscal_deliveries_attempts_check
    CHECK (attempts >= 0),
  -- Una entrega enviada sin fecha de envío no sirve para responder «¿cuándo se
  -- le mandó?», que es la única pregunta que se le va a hacer a esta tabla.
  CONSTRAINT fiscal_deliveries_sent_at_check
    CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);

-- Un documento no se manda dos veces a la misma dirección. Dos pulsaciones, o
-- un barrido de reintentos cruzado con el envío original, no pueden convertirse
-- en dos correos con la misma factura.
--
-- Por `lower(email)` porque la parte de dominio no distingue mayúsculas y
-- nadie espera que Ana@x.com y ana@x.com sean dos destinatarios.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_deliveries_invoice_email_idx
  ON fiscal_invoice_deliveries (invoice_id, lower(email));

-- La consulta del barrido: lo que queda por mandar, lo más viejo primero. Como
-- en la cola de dudas, y por lo mismo -- una factura de ayer que no ha llegado
-- es más urgente que una de hace un minuto.
CREATE INDEX IF NOT EXISTS fiscal_deliveries_pending_idx
  ON fiscal_invoice_deliveries (created_at)
  WHERE status <> 'SENT';

CREATE INDEX IF NOT EXISTS fiscal_deliveries_restaurant_idx
  ON fiscal_invoice_deliveries (restaurant_id, created_at DESC);

COMMENT ON TABLE fiscal_invoice_deliveries IS
  'El envío por correo de una factura, aparte del documento porque el documento '
  'es inmutable y esto no. Una factura vale igual si el correo no llegó.';

COMMIT;
