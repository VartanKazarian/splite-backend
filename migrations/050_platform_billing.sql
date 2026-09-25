-- La consola de Splite: quién la usa y qué le cobra Splite a cada restaurante.
--
-- Hasta aquí toda sesión de esta API pertenecía a un restaurante, y lo que
-- hacía el equipo de Splite (cambiar un plan, aprobar un alta) se hacía por
-- línea de comandos dentro del servidor. Esta migración añade dos cosas que no
-- existían:
--
--   1. Operadores de plataforma: personas de Splite, **no** usuarios de ningún
--      restaurante. Tabla propia, contraseña propia, segundo factor obligatorio
--      y una firma de sesión distinta de la del personal, para que una sesión
--      de un restaurante no pueda hacerse pasar por una de operador ni al revés.
--
--   2. Lo que Splite cobra: precios por plan, la suscripción de cada
--      restaurante, los cargos de cada periodo y los pagos recibidos.
--
-- Un cargo NO es una factura fiscal. Es el aviso interno de lo que un
-- restaurante debe por un periodo. La factura fiscal de Splite a sus clientes
-- la emite quien corresponda (imprenta o proveedor autorizado), fuera de aquí.

CREATE TABLE IF NOT EXISTS platform_operators (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            CITEXT NOT NULL,
  display_name     VARCHAR(80) NOT NULL,
  role             VARCHAR(20) NOT NULL CHECK (role IN ('ADMIN', 'SUPPORT')),
  -- Nula hasta que la persona completa su alta con el enlace de un solo uso.
  password_hash    TEXT,
  -- El secreto del segundo factor no se guarda: se deriva del secreto del
  -- servidor, del id y de esta versión. Subirla invalida el autenticador.
  totp_version     INT NOT NULL DEFAULT 1 CHECK (totp_version > 0),
  -- El último paso TOTP aceptado: un código no vale dos veces.
  totp_last_step   BIGINT,
  setup_token_hash VARCHAR(64),
  setup_expires_at TIMESTAMPTZ,
  activated_at     TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT platform_operators_active_needs_password
    CHECK (activated_at IS NULL OR password_hash IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS platform_operators_email_idx ON platform_operators (email);
CREATE UNIQUE INDEX IF NOT EXISTS platform_operators_setup_token_idx
  ON platform_operators (setup_token_hash) WHERE setup_token_hash IS NOT NULL;

-- El rastro de la consola. Aparte de `audit_logs` porque allí el actor es un
-- usuario de restaurante (clave foránea a `users`) y aquí es un operador.
CREATE TABLE IF NOT EXISTS operator_audit (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  action        VARCHAR(100) NOT NULL,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  resource_type VARCHAR(50),
  resource_id   UUID,
  details       JSONB,
  ip            INET,
  user_agent    TEXT,
  request_id    VARCHAR(128),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS operator_audit_restaurant_idx ON operator_audit (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS operator_audit_operator_idx ON operator_audit (operator_id, created_at DESC);

-- La lista de precios. Un precio nuevo es una fila nueva con su fecha: cambiar
-- la tarifa no reescribe lo que ya se cobró.
CREATE TABLE IF NOT EXISTS plan_prices (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier             VARCHAR(20) NOT NULL CHECK (tier IN ('STARTER', 'PRO', 'ENTERPRISE')),
  billing_cycle    VARCHAR(10) NOT NULL CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  amount_usd       BIGINT NOT NULL CHECK (amount_usd > 0),
  effective_from   DATE NOT NULL,
  created_by       UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT plan_prices_one_per_day UNIQUE (tier, billing_cycle, effective_from)
);

-- Cómo se le cobra a cada restaurante. El plan en sí sigue en
-- `restaurants.plan_tier`, que es lo que lee el producto; aquí sólo lo que es
-- de facturación.
CREATE TABLE IF NOT EXISTS restaurant_subscriptions (
  restaurant_id    UUID PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
  billing_cycle    VARCHAR(10) NOT NULL DEFAULT 'MONTHLY' CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  -- Nulo: se cobra la tarifa de la lista. Con valor: un precio pactado.
  custom_price_usd BIGINT CHECK (custom_price_usd IS NULL OR custom_price_usd >= 0),
  status           VARCHAR(12) NOT NULL DEFAULT 'ACTIVE'
                     CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CANCELLED')),
  notes            TEXT,
  updated_by       UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lo que un restaurante debe por un periodo, en dólares de referencia.
CREATE TABLE IF NOT EXISTS subscription_charges (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  tier             VARCHAR(20) NOT NULL,
  billing_cycle    VARCHAR(10) NOT NULL CHECK (billing_cycle IN ('MONTHLY', 'ANNUAL')),
  period_start     DATE NOT NULL,
  period_end       DATE NOT NULL,
  amount_usd       BIGINT NOT NULL CHECK (amount_usd > 0),
  due_on           DATE NOT NULL,
  status           VARCHAR(8) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAID', 'VOID')),
  paid_at          TIMESTAMPTZ,
  void_reason      TEXT,
  created_by       UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT subscription_charges_period CHECK (period_end > period_start),
  CONSTRAINT subscription_charges_paid_at CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
  CONSTRAINT subscription_charges_void_reason CHECK (status <> 'VOID' OR void_reason IS NOT NULL)
);
-- Un periodo se cobra una vez. Anulado, se puede volver a cobrar.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_charges_one_per_period
  ON subscription_charges (restaurant_id, period_start) WHERE status <> 'VOID';
CREATE INDEX IF NOT EXISTS subscription_charges_status_idx ON subscription_charges (status, due_on);

-- Lo que un restaurante pagó. En bolívares o en dólares; `applied_usd` es lo
-- que ese pago descuenta del cargo, a la tasa que se registró con él.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id    UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  charge_id        UUID REFERENCES subscription_charges(id) ON DELETE RESTRICT,
  method           VARCHAR(12) NOT NULL
                     CHECK (method IN ('PAGO_MOVIL', 'TRANSFER', 'USD_CASH', 'ZELLE', 'OTHER')),
  currency         VARCHAR(3) NOT NULL CHECK (currency IN ('VES', 'USD')),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  fx_rate          NUMERIC(20, 8) CHECK (fx_rate IS NULL OR fx_rate > 0),
  applied_usd      BIGINT NOT NULL CHECK (applied_usd >= 0),
  reference        VARCHAR(64),
  received_on      DATE NOT NULL,
  notes            TEXT,
  recorded_by      UUID REFERENCES platform_operators(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Un pago en bolívares sin tasa no se puede descontar de un cargo en dólares.
  CONSTRAINT subscription_payments_ves_rate CHECK (currency <> 'VES' OR fx_rate IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS subscription_payments_restaurant_idx
  ON subscription_payments (restaurant_id, received_on DESC);
CREATE INDEX IF NOT EXISTS subscription_payments_charge_idx ON subscription_payments (charge_id);
