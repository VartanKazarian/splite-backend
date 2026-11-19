-- Lo que opina el comensal después de pagar (R20).
--
-- Una opinión por comensal y por cuenta: quien pagó en dos veces no vota dos
-- veces, y quien cambia de idea la corrige en vez de sumar otra. La guarda el
-- restaurante, en privado; el enlace a Google se le ofrece a todos los que
-- valoran, sea cual sea la nota (pedírselo sólo a los contentos va contra las
-- normas de Google y puede costarle al restaurante sus reseñas).
CREATE TABLE IF NOT EXISTS diner_feedback (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id     UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id           UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
  -- El pago desde el que se valoró. Sin cascada sobre el pago: una opinión no
  -- se borra porque se anule un cobro.
  payment_id        UUID REFERENCES payments(id) ON DELETE SET NULL,
  guest_session_id  UUID REFERENCES guest_sessions(id) ON DELETE SET NULL,
  table_name        TEXT,
  rating            SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment           TEXT CHECK (comment IS NULL OR char_length(comment) <= 500),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS diner_feedback_one_per_diner
  ON diner_feedback (bill_id, guest_session_id);
CREATE INDEX IF NOT EXISTS diner_feedback_restaurant_recent
  ON diner_feedback (restaurant_id, created_at DESC);

-- Dónde dejar una reseña en Google, si el restaurante lo pone. Sin él, el
-- teléfono sólo da las gracias.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS google_review_url TEXT;
