-- Invitar a alguien del equipo en vez de inventarle una contraseña.
--
-- Hasta ahora, dar de alta a un mesero era que el dueño escribiera una
-- contraseña y se la dijera: la sabían los dos hasta que el mesero la cambiara,
-- si la cambiaba. Una invitación es un enlace de un solo uso con el que la
-- persona pone su propia contraseña, y nadie más la conoce nunca.
--
-- Lo que importa del diseño:
--
--   - **El token no se guarda**, sólo su SHA-256. Quien lea esta tabla -- una
--     copia de seguridad, un volcado -- no puede aceptar ninguna invitación.
--   - **Un solo uso y con caducidad.** `accepted_at` y `revoked_at` cierran la
--     invitación; `expires_at` la cierra sola.
--   - **Una abierta por dirección y restaurante.** Reenviar es anular la
--     anterior y crear otra: dos enlaces vivos para la misma persona serían dos
--     formas de entrar, y la vieja podría estar en un chat que ya no controlas.

BEGIN;

CREATE TABLE IF NOT EXISTS staff_invitations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  email             CITEXT NOT NULL,
  role              VARCHAR(20) NOT NULL,
  token_hash        CHAR(64) NOT NULL UNIQUE,
  invited_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  accepted_at       TIMESTAMPTZ,
  accepted_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at        TIMESTAMPTZ
);

ALTER TABLE staff_invitations DROP CONSTRAINT IF EXISTS staff_invitations_role_check;
ALTER TABLE staff_invitations ADD CONSTRAINT staff_invitations_role_check
  CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER', 'WAITER'));

-- Aceptada o anulada, nunca las dos.
ALTER TABLE staff_invitations DROP CONSTRAINT IF EXISTS staff_invitations_closed_check;
ALTER TABLE staff_invitations ADD CONSTRAINT staff_invitations_closed_check
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL));

ALTER TABLE staff_invitations DROP CONSTRAINT IF EXISTS staff_invitations_expiry_check;
ALTER TABLE staff_invitations ADD CONSTRAINT staff_invitations_expiry_check
  CHECK (expires_at > created_at);

CREATE UNIQUE INDEX IF NOT EXISTS staff_invitations_open_idx
  ON staff_invitations (restaurant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS staff_invitations_restaurant_idx
  ON staff_invitations (restaurant_id, created_at DESC);

COMMIT;
