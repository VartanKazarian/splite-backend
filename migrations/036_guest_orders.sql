-- Lo que pide el comensal desde su propio teléfono.
--
-- Hasta aquí, una cuenta sólo crecía por la mano de alguien de la casa: el
-- panel abre la cuenta y añade las líneas. El QR de la mesa servía para mirar
-- la carta y para pagar, no para pedir. Esto es lo que faltaba entre las dos
-- cosas.
--
-- **El pedido entra directo en la cuenta.** No hay cola de aprobación: las
-- líneas se insertan igual que las de un mesero, con las mismas validaciones
-- -- que el producto exista, que siga en la carta y que su moneda sea la de la
-- cuenta -- y con el mismo recálculo de totales dentro de la misma
-- transacción. Una mesa libre abre cuenta con el primer pedido, exactamente
-- como cuando la abre un mesero tomando nota.
--
-- Entonces, ¿para qué esta tabla, si las líneas ya están en `bill_items`?
--
-- Para que el panel pueda decir **"la Mesa 4 acaba de pedir"**. Un pedido es un
-- suceso -- tres tequeños y dos cachapas, a las 21:14, desde la mesa 4 -- y las
-- líneas sueltas no lo son: sin esto, seis líneas nuevas en una cuenta son
-- indistinguibles de seis líneas que tecleó un mesero hace media hora, y no hay
-- nada que avisar ni nada que dar por visto. `acknowledged_at` es esa mitad:
-- mientras sea NULL, el pedido está esperando a que alguien de la sala lo mire.
--
-- `guest_order_id` en `bill_items` ata las líneas a su suceso. Nullable porque
-- la inmensa mayoría de las líneas no vienen de un pedido: las pone el panel.
-- ON DELETE SET NULL y no CASCADE -- borrar el registro del pedido no puede
-- llevarse por delante lo que la cuenta debe.
--
-- Y `bill_id` es nullable por un caso concreto: la cuenta puede anularse
-- (`VOID`) o cerrarse y ser purgada mucho después, y el pedido es historia de
-- lo que pasó en la sala. Que se quede sin cuenta no lo invalida.
--
-- **Lo que esta tabla no es.** No es una comanda de cocina. No lleva estados de
-- preparación, ni impresión, ni tiempos: eso es un sistema distinto y con otro
-- dueño. Aquí sólo se registra que alguien pidió, qué, y si en la sala ya se
-- han enterado.

CREATE TABLE IF NOT EXISTS guest_orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id          UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  -- Sin FK: la sesión del comensal vive en Redis con caducidad y su fila en
  -- `guest_sessions` se purga; el pedido tiene que sobrevivir a las dos. Se
  -- guarda para poder seguir la pista de un abuso hasta la sesión que lo hizo.
  guest_session_id  UUID,
  bill_id           UUID REFERENCES bills(id) ON DELETE SET NULL,
  -- Cuántas líneas trajo. Se guarda en vez de contarlas porque las líneas se
  -- pueden quitar después, y "pidió tres cosas" sigue siendo cierto aunque el
  -- mesero haya borrado una.
  line_count        INTEGER NOT NULL CHECK (line_count > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL mientras nadie en la sala lo haya dado por visto. Es lo único que
  -- convierte esta tabla en una bandeja de avisos.
  acknowledged_at   TIMESTAMPTZ,
  acknowledged_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT guest_orders_ack_pair CHECK (
    (acknowledged_at IS NULL AND acknowledged_by IS NULL)
    OR acknowledged_at IS NOT NULL
  )
);

-- La consulta que hace el panel cada pocos segundos: los pedidos sin ver de
-- este restaurante, el más viejo primero. Parcial, porque los vistos no se
-- consultan nunca por este camino y son casi todos.
CREATE INDEX IF NOT EXISTS guest_orders_pending_idx
  ON guest_orders (restaurant_id, created_at)
  WHERE acknowledged_at IS NULL;

CREATE INDEX IF NOT EXISTS guest_orders_bill_idx ON guest_orders (bill_id);

ALTER TABLE bill_items
  ADD COLUMN IF NOT EXISTS guest_order_id UUID REFERENCES guest_orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS bill_items_guest_order_idx
  ON bill_items (guest_order_id) WHERE guest_order_id IS NOT NULL;
