-- «¿Olvidaste tu contraseña?»
--
-- Un enlace de un solo uso por correo. Como en las invitaciones, sólo se
-- guarda el hash del token: quien lea esta tabla no puede entrar con nada.
CREATE TABLE IF NOT EXISTS password_resets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  -- Pedir otro anula el anterior: sólo vale el último enlace.
  revoked_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS password_resets_user_recent_idx
  ON password_resets (user_id, created_at DESC);
