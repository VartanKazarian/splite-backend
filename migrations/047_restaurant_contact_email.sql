-- Adónde responde un cliente cuando contesta a su factura.
--
-- La factura sale de una dirección que no recibe respuestas -- la de envío,
-- verificada por DNS y común a todos los restaurantes --, y lo primero que
-- hace quien encuentra un error en su factura es darle a «responder». Sin
-- esto, esa respuesta se perdía.
--
-- Un campo propio y no el correo del dueño: ése es su usuario de acceso, y
-- repartirlo en cada factura a todos los clientes lo convertiría en público.
-- Vacío es legítimo: sin él, el correo no lleva Reply-To y lo dice.

BEGIN;

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);

COMMENT ON COLUMN restaurants.contact_email IS
  'Correo al que responden los clientes: va como Reply-To en las facturas.';

COMMIT;
