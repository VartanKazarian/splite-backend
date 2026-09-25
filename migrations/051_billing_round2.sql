-- Cobros, segunda vuelta: precios de salida, datos de cobro de Splite, avisos
-- de pago de los restaurantes y el registro de recordatorios enviados.

-- Los precios de salida, mensuales, en céntimos de dólar. Idempotente: si ya
-- hay un precio para ese plan y ese día (puesto a mano en la consola), manda
-- el de la consola.
INSERT INTO plan_prices (tier, billing_cycle, amount_usd, effective_from)
VALUES ('STARTER', 'MONTHLY', 900, DATE '2026-09-25'),
       ('PRO', 'MONTHLY', 2900, DATE '2026-09-25'),
       ('ENTERPRISE', 'MONTHLY', 5900, DATE '2026-09-25')
ON CONFLICT (tier, billing_cycle, effective_from) DO NOTHING;

-- Ajustes de la plataforma que cambia el equipo de Splite desde la consola.
-- Hoy sólo uno: a dónde pagan los restaurantes.
CREATE TABLE IF NOT EXISTS platform_settings (
  key         VARCHAR(64) PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- «Ya pagué», desde el panel del restaurante. No es un pago: es un aviso que
-- alguien de Splite comprueba contra su banco y confirma o rechaza. Al
-- confirmarlo se registra el pago de verdad (`subscription_payments`).
CREATE TABLE IF NOT EXISTS subscription_payment_notices (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  charge_id      UUID REFERENCES subscription_charges(id) ON DELETE SET NULL,
  method         VARCHAR(12) NOT NULL
                   CHECK (method IN ('PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER')),
  currency       VARCHAR(3) NOT NULL CHECK (currency IN ('VES', 'USD')),
  amount         BIGINT NOT NULL CHECK (amount > 0),
  reference      VARCHAR(64),
  paid_on        DATE NOT NULL,
  notes          TEXT,
  submitted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  status         VARCHAR(10) NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
  reviewed_by    UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  reviewed_at    TIMESTAMPTZ,
  reject_reason  TEXT,
  payment_id     UUID REFERENCES subscription_payments(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscription_notices_reviewed CHECK ((status = 'PENDING') = (reviewed_at IS NULL)),
  CONSTRAINT subscription_notices_rejected CHECK (status <> 'REJECTED' OR reject_reason IS NOT NULL),
  CONSTRAINT subscription_notices_confirmed CHECK (status <> 'CONFIRMED' OR payment_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS subscription_notices_status_idx
  ON subscription_payment_notices (status, created_at);
CREATE INDEX IF NOT EXISTS subscription_notices_restaurant_idx
  ON subscription_payment_notices (restaurant_id, created_at DESC);
-- La misma referencia no se avisa dos veces (salvo que se rechazara).
CREATE UNIQUE INDEX IF NOT EXISTS subscription_notices_one_per_reference
  ON subscription_payment_notices (restaurant_id, reference)
  WHERE reference IS NOT NULL AND status <> 'REJECTED';

-- Qué recordatorio se mandó de cada cargo, para no mandarlo dos veces.
CREATE TABLE IF NOT EXISTS billing_reminders (
  charge_id  UUID NOT NULL REFERENCES subscription_charges(id) ON DELETE CASCADE,
  kind       VARCHAR(20) NOT NULL CHECK (kind IN ('ISSUED', 'OVERDUE', 'OVERDUE_7')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (charge_id, kind)
);
