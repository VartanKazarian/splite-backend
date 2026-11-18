-- El primer pedido de un teléfono nuevo, aprobado por la sala.
--
-- El QR está pegado a la mesa: cualquiera que lo fotografíe puede abrir una
-- sesión desde fuera y pedir -- o abrir una cuenta en una mesa vacía -- como
-- broma. Con esto encendido, el primer pedido de cada sesión espera a que
-- alguien de la sala lo apruebe; los siguientes de esa sesión entran solos.
--
-- Por restaurante y apagado por defecto: un local que conoce a su clientela
-- no tiene por qué pagar la espera.
ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS approve_new_phone_orders BOOLEAN NOT NULL DEFAULT false;

-- Cuándo la sala aprobó un pedido de esta sesión (desde entonces pide sin
-- espera) y cuándo rechazó uno (desde entonces no pide: tiene que volver a
-- escanear, que tiene su propio límite por IP).
ALTER TABLE guest_sessions
  ADD COLUMN IF NOT EXISTS orders_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS orders_rejected_at TIMESTAMPTZ;

-- PLACED: las líneas están en la cuenta (todos los pedidos hasta ahora).
-- HELD: esperando a la sala; las líneas están en `held_items`, no en la cuenta,
--       y `bill_id` es NULL porque todavía no ha tocado ninguna.
-- REJECTED: la sala dijo que no; nunca llegó a la cuenta.
ALTER TABLE guest_orders
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PLACED',
  ADD COLUMN IF NOT EXISTS held_items JSONB,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE guest_orders DROP CONSTRAINT IF EXISTS guest_orders_status_check;
ALTER TABLE guest_orders ADD CONSTRAINT guest_orders_status_check
  CHECK (status IN ('PLACED', 'HELD', 'REJECTED'));

ALTER TABLE guest_orders DROP CONSTRAINT IF EXISTS guest_orders_held_items_check;
ALTER TABLE guest_orders ADD CONSTRAINT guest_orders_held_items_check
  CHECK (status <> 'HELD' OR (held_items IS NOT NULL AND bill_id IS NULL));

-- Uno esperando por sesión: quien insiste no llena la bandeja.
CREATE UNIQUE INDEX IF NOT EXISTS guest_orders_one_held_per_session
  ON guest_orders (guest_session_id) WHERE status = 'HELD';
