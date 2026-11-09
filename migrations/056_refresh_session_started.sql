-- Cuándo se inició la sesión de personal, para su tope absoluto.
--
-- Cada renovación crea una fila nueva con un plazo entero por delante, así que
-- una sesión usada a menudo no caducaba nunca: ni la de una tablet de caja que
-- no se apaga, ni la de un token robado que se renueva a tiempo. La hora de
-- inicio pasa de fila en fila y la sesión termina, se use o no, cuando llega a
-- JWT_SESSION_MAX_SECONDS (16 h por defecto) desde el inicio de sesión.
--
-- Las filas existentes toman NOW(): su tope empieza a contar al desplegar.
ALTER TABLE refresh_sessions
  ADD COLUMN IF NOT EXISTS session_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
