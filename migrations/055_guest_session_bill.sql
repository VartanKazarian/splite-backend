-- Una sesión de comensal es de una cuenta, no de una mesa.
--
-- Hasta ahora la sesión valía para «la cuenta abierta de esta mesa», sea cual
-- fuera, durante dos horas de inactividad. Quien se iba con la sesión abierta
-- en el teléfono veía -- y podía pedir sobre -- la cuenta de los siguientes
-- que se sentaban en esa mesa.
--
-- Ahora la sesión se ata a la cuenta abierta al escanear, o a la primera que
-- se abra poco después si la mesa estaba vacía (GUEST_BILL_BIND_WINDOW_SECONDS).
-- Cuando esa cuenta se cierra o se anula, la sesión ya no ve ninguna otra; sus
-- recibos y su factura siguen al alcance porque se resuelven desde el pago.
--
-- NULL = todavía sin cuenta (mesa vacía al escanear, o sesión anterior a esta
-- migración: se ata en el siguiente acceso con la misma regla de ventana).
ALTER TABLE guest_sessions
  ADD COLUMN IF NOT EXISTS bill_id UUID;

ALTER TABLE guest_sessions
  DROP CONSTRAINT IF EXISTS guest_sessions_bill_fk;
ALTER TABLE guest_sessions
  ADD CONSTRAINT guest_sessions_bill_fk
  FOREIGN KEY (bill_id, restaurant_id) REFERENCES bills (id, restaurant_id) ON DELETE CASCADE;

COMMENT ON COLUMN guest_sessions.bill_id IS
  'The one bill this session may see and act on. Set at scan (or on the first bill opened within the bind window). A session never moves to another bill.';
