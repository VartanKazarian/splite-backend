-- Conexiones con el banco del restaurante, para cualquier banco.
--
-- Hasta ahora un aviso de Pago Móvil lo confirmaba una persona mirando la app
-- del banco. Esto es la parte común a todas las formas de automatizarlo: los
-- movimientos que entran en la cuenta del restaurante, vengan de donde vengan,
-- y el resultado de compararlos con los avisos pendientes.
--
-- Una conexión es de dónde llegan los movimientos:
--
--   WEBHOOK            cualquier sistema que pueda hacer un POST firmado: un
--                      servicio de verificación, un reenviador de correos del
--                      banco, un script del restaurante. Ver
--                      docs/bank-connections.md.
--   STATEMENT_IMPORT   el estado de cuenta que el restaurante descarga de su
--                      banco (CSV o TXT) y sube. Funciona con todos los bancos
--                      desde hoy, sin credenciales de nadie.
--
-- Las APIs directas de cada banco (Mercantil, Banesco, BDV...) entrarán como
-- otro `kind` cuando haya credenciales con que probarlas; el resto de este
-- esquema no cambia.

BEGIN;

CREATE TABLE IF NOT EXISTS bank_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  kind             VARCHAR(20) NOT NULL,
  label            VARCHAR(80) NOT NULL,
  -- El banco de la cuenta, si se sabe. Sólo informativo: un movimiento trae el
  -- banco de *origen*, que es otra cosa.
  bank_code        CHAR(4),
  -- ¿Puede un movimiento de aquí confirmar un aviso él solo? Apagado por
  -- defecto: hasta que el restaurante se fíe de la fuente, sólo sugiere.
  auto_confirm     BOOLEAN NOT NULL DEFAULT false,
  -- La firma de un WEBHOOK se deriva de un secreto del servidor, del id y de
  -- esta versión; rotarla es subir la versión. No se guarda ningún secreto.
  secret_version   INTEGER NOT NULL DEFAULT 1,
  -- Para STATEMENT_IMPORT: qué columna del fichero es cada dato.
  column_map       JSONB,
  active           BOOLEAN NOT NULL DEFAULT true,
  last_movement_at TIMESTAMPTZ,
  last_error       VARCHAR(300),
  last_error_at    TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE bank_connections DROP CONSTRAINT IF EXISTS bank_connections_kind_check;
ALTER TABLE bank_connections ADD CONSTRAINT bank_connections_kind_check
  CHECK (kind IN ('WEBHOOK', 'STATEMENT_IMPORT'));

ALTER TABLE bank_connections DROP CONSTRAINT IF EXISTS bank_connections_version_check;
ALTER TABLE bank_connections ADD CONSTRAINT bank_connections_version_check
  CHECK (secret_version >= 1);

CREATE INDEX IF NOT EXISTS bank_connections_restaurant_idx
  ON bank_connections (restaurant_id, created_at);

-- Un dinero que entró en la cuenta del restaurante.
--
-- Sólo entradas: una salida no confirma ningún aviso. El mismo movimiento puede
-- llegar dos veces -- el mismo estado de cuenta subido otra vez, un webhook
-- reintentado, dos fuentes que ven la misma cuenta --, y el índice único lo
-- deja entrar una sola.
CREATE TABLE IF NOT EXISTS bank_movements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  connection_id    UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  -- Sólo dígitos. Cada banco la escribe a su manera; lo que se compara son
  -- los dígitos.
  reference        VARCHAR(40) NOT NULL,
  amount_minor     BIGINT NOT NULL,
  occurred_at      TIMESTAMPTZ,
  phone_origin     VARCHAR(20),
  id_origin        VARCHAR(20),
  bank_code        CHAR(4),
  description      VARCHAR(200),
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- El aviso que este movimiento respalda, una vez usado. Un movimiento
  -- respalda un aviso como mucho: dos avisos con la misma referencia no
  -- pueden cobrarse los dos con un solo pago.
  matched_payment_id UUID REFERENCES payments(id) ON DELETE SET NULL
);

ALTER TABLE bank_movements DROP CONSTRAINT IF EXISTS bank_movements_amount_check;
ALTER TABLE bank_movements ADD CONSTRAINT bank_movements_amount_check CHECK (amount_minor > 0);

ALTER TABLE bank_movements DROP CONSTRAINT IF EXISTS bank_movements_reference_check;
ALTER TABLE bank_movements ADD CONSTRAINT bank_movements_reference_check
  CHECK (reference ~ '^[0-9]{4,40}$');

CREATE UNIQUE INDEX IF NOT EXISTS bank_movements_dedupe_idx
  ON bank_movements (restaurant_id, reference, amount_minor);

CREATE UNIQUE INDEX IF NOT EXISTS bank_movements_matched_idx
  ON bank_movements (matched_payment_id) WHERE matched_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bank_movements_open_idx
  ON bank_movements (restaurant_id, received_at DESC) WHERE matched_payment_id IS NULL;

-- Lo que dijo el banco de cada aviso, la última vez que se miró.
--
-- Aparte de `payments` a propósito: un pago tiene su propia máquina de estados
-- con triggers, y esto no es un estado del pago sino una opinión sobre él que
-- cambia cada vez que llegan movimientos nuevos.
CREATE TABLE IF NOT EXISTS payment_bank_matches (
  payment_id       UUID PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  outcome          VARCHAR(12) NOT NULL,
  movement_id      UUID REFERENCES bank_movements(id) ON DELETE SET NULL,
  disagreements    TEXT[] NOT NULL DEFAULT '{}',
  auto_confirmed   BOOLEAN NOT NULL DEFAULT false,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payment_bank_matches DROP CONSTRAINT IF EXISTS payment_bank_matches_outcome_check;
ALTER TABLE payment_bank_matches ADD CONSTRAINT payment_bank_matches_outcome_check
  CHECK (outcome IN ('MATCHED', 'MISMATCH', 'AMBIGUOUS', 'NOT_FOUND'));

COMMIT;
