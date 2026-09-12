-- El borrador que se le mandó al proveedor, guardado con la petición.
--
-- Hace falta por el caso ambiguo, que es el que gobierna todo este diseño.
--
-- Cuando el proveedor contesta algo que no dice si emitió, la respuesta llega
-- después: se le pregunta por la clave de idempotencia, a veces minutos u horas
-- más tarde, desde una cola que mira una persona. Para entonces la cuenta ha
-- seguido viva -- han pagado otros comensales, se han emitido otras facturas --
-- y lo que quedaba por declarar ya no es lo que era.
--
-- Reconstruir el borrador en ese momento daría **otro** documento, y el que el
-- proveedor emitió fue el primero. Lo que hay que guardar es lo que se mandó,
-- no lo que hoy saldría.
--
-- JSONB y no columnas: es una instantánea muerta, no algo que se consulte por
-- partes. Darle forma de tablas invitaría a leerla como si fuera el estado
-- actual, que es precisamente lo que no es.

BEGIN;

ALTER TABLE fiscal_invoice_requests
  ADD COLUMN IF NOT EXISTS draft_json JSONB;

COMMENT ON COLUMN fiscal_invoice_requests.draft_json IS
  'Instantánea del documento que se envió: líneas, desglose por alícuota e '
  'importes, en bolívares. Es lo que hay que registrar si más tarde resulta que '
  'el proveedor sí lo emitió -- para entonces la cuenta ya no da el mismo '
  'borrador. No se lee como estado actual de nada.';

COMMIT;
