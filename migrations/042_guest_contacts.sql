-- Los datos del comensal, con la finalidad separada del dato.
--
-- El correo se pide con una excusa concreta -- recibir la factura -- y el
-- restaurante quiere además poder mandar promociones. **Son dos finalidades
-- distintas**, y meterlas en el mismo sí es exactamente lo que se impugna
-- después: nadie que escribió su correo para que le llegara una factura ha
-- aceptado con eso recibir publicidad.
--
-- Así que aquí el consentimiento comercial es una columna propia, con su fecha
-- y su procedencia, y por defecto es `false`. Un booleano suelto no sirve: en
-- una reclamación lo que hay que poder enseñar es *cuándo* se dio y *desde
-- dónde*, no que alguien marcó algo alguna vez.
--
-- Y se puede retirar. Un consentimiento que no se puede retirar no es un
-- consentimiento, y sin una columna donde apuntarlo la única forma de honrar
-- una baja sería borrar la fila -- perdiendo la prueba de que en su día sí se
-- dio, que es justo lo que habría que enseñar.
--
-- El contacto es **del restaurante**, no de Splite. El comensal se lo dio a un
-- local concreto, y por eso la clave única lleva el restaurante dentro: el
-- mismo correo puede estar en dos restaurantes con respuestas distintas, y
-- cruzarlos sería usar un dato para algo que nadie autorizó.

BEGIN;

CREATE TABLE IF NOT EXISTS guest_contacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Normalizado en minúsculas por la aplicación antes de escribir, para que
  -- `Ana@X.com` y `ana@x.com` no sean dos contactos ni dos bajas distintas.
  email             VARCHAR(255) NOT NULL,
  name              VARCHAR(160),

  -- La finalidad transaccional: se le mandó o se le puede mandar su factura.
  -- Siempre cierta cuando la fila existe -- es la razón por la que se pidió --
  -- y deliberadamente separada de la de abajo.
  invoice_opt_in    BOOLEAN NOT NULL DEFAULT true,

  -- La finalidad comercial. Por defecto **false**: sólo es cierta si alguien
  -- marcó una casilla que estaba vacía.
  marketing_consent BOOLEAN NOT NULL DEFAULT false,
  consent_at        TIMESTAMPTZ,
  -- Desde dónde se dio, para poder reconstruir la pantalla que vio.
  consent_source    VARCHAR(40),
  withdrawn_at      TIMESTAMPTZ,

  -- De dónde salió, para poder responder «¿de dónde tienen mi correo?».
  bill_id           UUID REFERENCES bills(id) ON DELETE SET NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un consentimiento vigente tiene fecha, y uno retirado no está vigente. La
-- base lo impone porque es la afirmación que habría que defender.
ALTER TABLE guest_contacts DROP CONSTRAINT IF EXISTS guest_contacts_consent_dated;
ALTER TABLE guest_contacts ADD CONSTRAINT guest_contacts_consent_dated
  CHECK (marketing_consent = false OR consent_at IS NOT NULL);

ALTER TABLE guest_contacts DROP CONSTRAINT IF EXISTS guest_contacts_withdrawal_clears;
ALTER TABLE guest_contacts ADD CONSTRAINT guest_contacts_withdrawal_clears
  CHECK (withdrawn_at IS NULL OR marketing_consent = false);

-- Un contacto por correo y restaurante. El mismo correo en dos locales son dos
-- contactos con dos respuestas propias: cruzarlos sería usar el dato para algo
-- que nadie autorizó.
CREATE UNIQUE INDEX IF NOT EXISTS guest_contacts_email_idx
  ON guest_contacts (restaurant_id, lower(email));

-- La lista que el restaurante puede usar de verdad: sólo quien dijo que sí y
-- no se ha dado de baja.
CREATE INDEX IF NOT EXISTS guest_contacts_marketing_idx
  ON guest_contacts (restaurant_id, created_at DESC)
  WHERE marketing_consent = true AND withdrawn_at IS NULL;

DROP TRIGGER IF EXISTS guest_contacts_set_updated_at ON guest_contacts;
CREATE TRIGGER guest_contacts_set_updated_at
  BEFORE UPDATE ON guest_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN guest_contacts.marketing_consent IS
  'Sólo true si el comensal marcó una casilla que estaba vacía. Dar el correo '
  'para recibir una factura NO es consentir publicidad.';
COMMENT ON COLUMN guest_contacts.withdrawn_at IS
  'Cuándo se dio de baja. La fila se conserva: borrarla perdería la prueba de '
  'que el consentimiento existió, que es lo que habría que enseñar.';

COMMIT;
