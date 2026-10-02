-- Una nota del comensal con su pedido: «la hamburguesa sin cebolla», «todo
-- para compartir». Sin ella esto se decía levantando la mano, que es justo lo
-- que pedir desde el teléfono venía a ahorrar.
--
-- Una por pedido y no por línea: lo que se pide así casi siempre afecta a un
-- plato que se nombra en la propia nota, y una caja por plato llenaría la
-- pantalla de campos vacíos. Doscientos caracteres bastan para eso y no para
-- usarla de chat con la cocina.
ALTER TABLE guest_orders
  ADD COLUMN IF NOT EXISTS note TEXT;

ALTER TABLE guest_orders
  DROP CONSTRAINT IF EXISTS guest_orders_note_length;
ALTER TABLE guest_orders
  ADD CONSTRAINT guest_orders_note_length CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200);
