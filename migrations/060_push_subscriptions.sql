-- Avisos en el teléfono del personal, con la pantalla bloqueada (R19).
--
-- Una fila por navegador suscrito. El `endpoint` es la dirección que da el
-- servicio de push del navegador (Google, Mozilla, Apple, Microsoft) y es
-- único: si en ese teléfono entra otra persona, la fila pasa a ser suya.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint       TEXT NOT NULL UNIQUE,
  -- Las dos claves con las que se cifra cada aviso para ese navegador.
  p256dh         TEXT NOT NULL,
  auth           TEXT NOT NULL,
  user_agent     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sent_at   TIMESTAMPTZ,
  -- Fallos seguidos que no fueron un «esta suscripción ya no existe» (eso la
  -- borra en el acto). Se pone a cero con el primer envío que llega.
  failures       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_subscriptions_restaurant_idx
  ON push_subscriptions (restaurant_id);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON push_subscriptions (user_id);

-- El par de claves VAPID con el que el servidor firma cada envío, si no vienen
-- por entorno. Se genera una vez, la primera vez que hace falta, y no cambia:
-- cambiarlo invalida todas las suscripciones. Una sola fila.
CREATE TABLE IF NOT EXISTS push_vapid_keys (
  id           SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  public_key   TEXT NOT NULL,
  private_key  TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
