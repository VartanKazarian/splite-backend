-- Los fallos que ve la gente en el navegador, para que alguien de Splite los
-- vea también.
--
-- Uno por huella y día: el mismo error en cien teléfonos es una fila con
-- `occurrences = 100`, no cien filas. Sin datos personales: la dirección sin
-- consulta ni fragmento (ahí viajan el token del QR y el del enlace para
-- cambiar la contraseña), y sin cuerpo de ninguna petición.
CREATE TABLE IF NOT EXISTS client_errors (
  id            BIGSERIAL PRIMARY KEY,
  day           DATE NOT NULL DEFAULT CURRENT_DATE,
  fingerprint   TEXT NOT NULL,
  message       TEXT NOT NULL,
  stack         TEXT,
  path          TEXT,
  surface       TEXT,
  release       TEXT,
  user_agent    TEXT,
  occurrences   INTEGER NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_errors_one_per_day
  ON client_errors (day, fingerprint);
CREATE INDEX IF NOT EXISTS client_errors_recent ON client_errors (last_seen_at DESC);
