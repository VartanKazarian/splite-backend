-- El «Servicio de Notificación de Pagos» de Mercantil como otra fuente de
-- movimientos (ver src/payments/providers/mercantil/notification.js).
--
-- Mercantil manda a una sola URL de Splite los pagos P2C de todos los
-- restaurantes, cifrados con la llave de cada uno, y dice de quién es cada
-- mensaje con el RIF en la cabecera `CompIdentif`. La conexión guarda ese RIF,
-- para encontrarla, y la llave, para descifrar.
--
-- La llave es un secreto que entrega el banco y no podemos rotar nosotros: se
-- guarda sellada con PAYMENT_CREDENTIALS_KEYS, como las credenciales de las
-- APIs de pago, y ninguna respuesta la devuelve.

BEGIN;

ALTER TABLE bank_connections
  ADD COLUMN IF NOT EXISTS merchant_rif            VARCHAR(16),
  ADD COLUMN IF NOT EXISTS credentials_encrypted   BYTEA,
  ADD COLUMN IF NOT EXISTS credentials_key_version SMALLINT;

ALTER TABLE bank_connections DROP CONSTRAINT IF EXISTS bank_connections_kind_check;
ALTER TABLE bank_connections ADD CONSTRAINT bank_connections_kind_check
  CHECK (kind IN ('WEBHOOK', 'STATEMENT_IMPORT', 'MERCANTIL_P2C'));

-- Una conexión de Mercantil sin RIF o sin llave no puede recibir nada; las
-- demás no tienen ni lo uno ni lo otro.
ALTER TABLE bank_connections DROP CONSTRAINT IF EXISTS bank_connections_mercantil_check;
ALTER TABLE bank_connections ADD CONSTRAINT bank_connections_mercantil_check
  CHECK (
    (kind = 'MERCANTIL_P2C'
      AND merchant_rif ~ '^[VEJGPC][0-9]{5,15}$'
      AND credentials_encrypted IS NOT NULL
      AND credentials_key_version IS NOT NULL)
    OR
    (kind <> 'MERCANTIL_P2C'
      AND merchant_rif IS NULL
      AND credentials_encrypted IS NULL
      AND credentials_key_version IS NULL)
  );

-- Un RIF, una conexión activa en todo Splite: es la única forma de saber a qué
-- restaurante va un mensaje.
CREATE UNIQUE INDEX IF NOT EXISTS bank_connections_mercantil_rif_idx
  ON bank_connections (merchant_rif) WHERE active AND kind = 'MERCANTIL_P2C';

COMMIT;
