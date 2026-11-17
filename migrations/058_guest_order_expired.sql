-- Un pedido retenido que nadie aprobó ni rechazó a tiempo caduca solo.
--
-- EXPIRED y no REJECTED: nadie dijo que no. El teléfono puede volver a pedir
-- (un rechazo lo bloquea; esto no), y la pantalla le dice al comensal que
-- llame al mesero en vez de que el personal no aceptó su pedido.
ALTER TABLE guest_orders DROP CONSTRAINT IF EXISTS guest_orders_status_check;
ALTER TABLE guest_orders ADD CONSTRAINT guest_orders_status_check
  CHECK (status IN ('PLACED', 'HELD', 'REJECTED', 'EXPIRED'));
