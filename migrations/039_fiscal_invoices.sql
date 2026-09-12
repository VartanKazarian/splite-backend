-- Facturación fiscal: documentos, líneas, impuestos y el intento que los pide.
--
-- Lo que este esquema tiene que sostener, y que no es obvio: sobre una misma
-- mesa se emiten **varias** facturas, una por comensal que paga, y entre todas
-- tienen que declarar exactamente la cuenta. Ni un céntimo de base imponible de
-- más ni de menos, y lo mismo por cada alícuota. El reparto lo resuelve
-- `src/services/fiscalAllocation.js`; aquí se guarda su resultado.
--
-- Tres decisiones dan forma a todo lo demás.
--
-- 1. El documento emitido y el intento de emitirlo son tablas distintas.
--    Una factura fiscal no cambia de estado: o existe o no existe. Lo que sí
--    tiene estados, reintentos y respuestas ambiguas del proveedor es la
--    *petición*. Mezclarlas obligaría a permitir UPDATE sobre un registro legal
--    para poder mover un campo de progreso.
--
-- 2. La inmutabilidad la impone la base, no la costumbre. Hay disparadores que
--    rechazan UPDATE y DELETE sobre las tres tablas del documento. Una factura
--    emitida no se corrige: se compensa con una nota de crédito.
--
-- 3. Las notas de crédito y débito caben desde el primer día. No hace falta
--    implementarlas ya, pero meterlas después obligaría a tocar tablas que para
--    entonces serán registros legales de un contribuyente.
--
-- Nada de esto hace a Splite conforme por estar escrito. Hasta conectar una
-- imprenta digital autorizada de verdad y validar la configuración con un
-- contador, esto es arquitectura preparada y hay que llamarla así.

BEGIN;

-- ------------------------------------------------------- el intento, mutable

-- Lo que se le pide al proveedor, y en qué va.
--
-- Vive aparte del documento justo para poder cambiar: reintentos, errores y
-- sobre todo el estado que de verdad importa, UNCERTAIN -- el proveedor
-- respondió algo que no permite saber si emitió o no. Ante eso se pregunta,
-- nunca se reintenta a ciegas: una factura duplicada es un problema fiscal del
-- restaurante, no un error de aplicación.
CREATE TABLE IF NOT EXISTS fiscal_invoice_requests (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id       UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id             UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,

  -- El pago que esta factura documenta. Uno a uno: cada comensal que paga y
  -- pide factura genera la suya. Nulo sólo para una nota de crédito, que
  -- compensa un documento y no un cobro.
  payment_id          UUID REFERENCES payments(id) ON DELETE RESTRICT,

  document_type       VARCHAR(20) NOT NULL DEFAULT 'INVOICE',
  status              VARCHAR(20) NOT NULL DEFAULT 'PENDING',

  -- La clave con la que se habla con el proveedor. Se genera antes de la
  -- primera llamada y no cambia entre reintentos: es lo que permite preguntar
  -- «¿emitiste ya esto?» en vez de mandarlo otra vez.
  idempotency_key     VARCHAR(128) NOT NULL,

  provider            VARCHAR(40),
  provider_request_id VARCHAR(200),
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error_code     VARCHAR(80),
  -- Sin cuerpo de error crudo: puede traer datos del proveedor y del cliente, y
  -- esta tabla se consulta a mano. El detalle va al log, con su requestId.
  last_attempt_at     TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fiscal_invoice_requests DROP CONSTRAINT IF EXISTS fiscal_invoice_requests_status_check;
ALTER TABLE fiscal_invoice_requests ADD CONSTRAINT fiscal_invoice_requests_status_check
  CHECK (status IN ('PENDING', 'SENT', 'ISSUED', 'FAILED', 'UNCERTAIN'));

ALTER TABLE fiscal_invoice_requests DROP CONSTRAINT IF EXISTS fiscal_invoice_requests_type_check;
ALTER TABLE fiscal_invoice_requests ADD CONSTRAINT fiscal_invoice_requests_type_check
  CHECK (document_type IN ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'));

-- Un pago se factura una vez. Es la barrera estructural contra el duplicado:
-- dos peticiones simultáneas para el mismo cobro no pueden existir, aunque el
-- comensal pulse dos veces o un reintento se cruce con la respuesta.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_requests_payment_idx
  ON fiscal_invoice_requests (payment_id)
  WHERE payment_id IS NOT NULL AND status <> 'FAILED';

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_requests_idempotency_idx
  ON fiscal_invoice_requests (restaurant_id, idempotency_key);

-- La cola que mira una persona: lo que quedó en duda, primero lo más viejo.
CREATE INDEX IF NOT EXISTS fiscal_requests_attention_idx
  ON fiscal_invoice_requests (restaurant_id, created_at)
  WHERE status IN ('UNCERTAIN', 'FAILED');

CREATE INDEX IF NOT EXISTS fiscal_requests_bill_idx
  ON fiscal_invoice_requests (restaurant_id, bill_id, created_at DESC);

DROP TRIGGER IF EXISTS fiscal_invoice_requests_set_updated_at ON fiscal_invoice_requests;
CREATE TRIGGER fiscal_invoice_requests_set_updated_at
  BEFORE UPDATE ON fiscal_invoice_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------- el documento, inmutable

-- La factura emitida. Se escribe una vez, cuando el proveedor confirma.
CREATE TABLE IF NOT EXISTS fiscal_invoices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id      UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  request_id         UUID NOT NULL UNIQUE REFERENCES fiscal_invoice_requests(id) ON DELETE RESTRICT,
  bill_id            UUID NOT NULL REFERENCES bills(id) ON DELETE RESTRICT,
  payment_id         UUID REFERENCES payments(id) ON DELETE RESTRICT,

  document_type      VARCHAR(20) NOT NULL DEFAULT 'INVOICE',

  -- Qué documento compensa esta nota de crédito. Una factura emitida no se
  -- corrige ni se anula: se emite otro documento que la deja a cero.
  compensates_id     UUID REFERENCES fiscal_invoices(id) ON DELETE RESTRICT,

  -- Los dos números que hacen fiscal a un documento, y que **los pone el
  -- proveedor autorizado, nunca Splite**. Inventarlos sería falsificar.
  document_number    VARCHAR(60) NOT NULL,
  control_number     VARCHAR(60) NOT NULL,
  provider           VARCHAR(40) NOT NULL,
  provider_document_id VARCHAR(200),

  -- Cómo se representó el consumo en las líneas, guardado en el propio
  -- documento para que dentro de dos años se pueda saber cómo se construyó:
  --   ITEMISED   se sabía qué consumió esta persona; las líneas son las suyas.
  --   PRORATED   líneas de la cuenta repartidas según lo que pagó.
  --   AGGREGATE  una línea, «consumo -- parte de la cuenta de la mesa N».
  line_basis         VARCHAR(20) NOT NULL,

  -- Importes en bolívares, que es la moneda en la que se declara. La cuenta
  -- puede estar en otra: la tasa es la **congelada en la cuenta**, y no se
  -- vuelve a consultar al BCV jamás. Una factura que se recalculara con la tasa
  -- de hoy declararía algo distinto de lo que se cobró.
  currency           VARCHAR(3) NOT NULL DEFAULT 'VES',
  fx_rate_ves_per_unit NUMERIC(20,8),
  subtotal_minor     BIGINT NOT NULL,
  vat_minor          BIGINT NOT NULL,
  service_minor      BIGINT NOT NULL,
  total_minor        BIGINT NOT NULL,

  -- El receptor. Nulo es **consumidor final**, que es el caso mayoritario y no
  -- una ficha a medio llenar: la mayoría de la gente no da su cédula por una
  -- cena. El diseño lo trata como el camino principal.
  customer_name      VARCHAR(160),
  customer_tax_id    VARCHAR(20),
  customer_email     VARCHAR(255),

  issued_at          TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fiscal_invoices DROP CONSTRAINT IF EXISTS fiscal_invoices_type_check;
ALTER TABLE fiscal_invoices ADD CONSTRAINT fiscal_invoices_type_check
  CHECK (document_type IN ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'));

ALTER TABLE fiscal_invoices DROP CONSTRAINT IF EXISTS fiscal_invoices_basis_check;
ALTER TABLE fiscal_invoices ADD CONSTRAINT fiscal_invoices_basis_check
  CHECK (line_basis IN ('ITEMISED', 'PRORATED', 'AGGREGATE'));

-- El total es exactamente sus partes, igual que en `bills`. Un documento que no
-- cuadra consigo mismo no se puede guardar, ni por la aplicación ni por nada.
ALTER TABLE fiscal_invoices DROP CONSTRAINT IF EXISTS fiscal_invoices_total_check;
ALTER TABLE fiscal_invoices ADD CONSTRAINT fiscal_invoices_total_check
  CHECK (total_minor = subtotal_minor + vat_minor + service_minor);

ALTER TABLE fiscal_invoices DROP CONSTRAINT IF EXISTS fiscal_invoices_amounts_check;
ALTER TABLE fiscal_invoices ADD CONSTRAINT fiscal_invoices_amounts_check
  CHECK (subtotal_minor >= 0 AND vat_minor >= 0 AND service_minor >= 0);

-- Una nota de crédito compensa algo; una factura no compensa nada.
ALTER TABLE fiscal_invoices DROP CONSTRAINT IF EXISTS fiscal_invoices_compensates_check;
ALTER TABLE fiscal_invoices ADD CONSTRAINT fiscal_invoices_compensates_check
  CHECK ((document_type = 'INVOICE' AND compensates_id IS NULL)
      OR (document_type <> 'INVOICE' AND compensates_id IS NOT NULL));

-- El número de control es único por proveedor: es su serie, no la nuestra.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_invoices_control_idx
  ON fiscal_invoices (provider, control_number);

CREATE INDEX IF NOT EXISTS fiscal_invoices_bill_idx
  ON fiscal_invoices (restaurant_id, bill_id, issued_at DESC);

CREATE INDEX IF NOT EXISTS fiscal_invoices_issued_idx
  ON fiscal_invoices (restaurant_id, issued_at DESC);

-- El libro de ventas se saca por fecha y alícuota; sin esto es un recorrido
-- completo de una tabla que sólo crece y que hay que conservar diez años.
CREATE INDEX IF NOT EXISTS fiscal_invoices_customer_tax_idx
  ON fiscal_invoices (restaurant_id, customer_tax_id)
  WHERE customer_tax_id IS NOT NULL;

-- ------------------------------------------------------------ líneas e IVA

CREATE TABLE IF NOT EXISTS fiscal_invoice_lines (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     UUID NOT NULL REFERENCES fiscal_invoices(id) ON DELETE RESTRICT,
  restaurant_id  UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  position       INTEGER NOT NULL,

  description    VARCHAR(300) NOT NULL,
  -- Cantidad en milésimas, porque una línea prorrateada puede ser una fracción
  -- de plato: 0,338 hamburguesas. Un entero mentiría y un float no es dinero.
  quantity_milli BIGINT NOT NULL,
  unit_price_minor BIGINT NOT NULL,

  tax_category   VARCHAR(16) NOT NULL,
  vat_bps        INTEGER NOT NULL,
  base_minor     BIGINT NOT NULL,
  vat_minor      BIGINT NOT NULL,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fiscal_invoice_lines DROP CONSTRAINT IF EXISTS fiscal_invoice_lines_category_check;
ALTER TABLE fiscal_invoice_lines ADD CONSTRAINT fiscal_invoice_lines_category_check
  CHECK (tax_category IN ('TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'));

ALTER TABLE fiscal_invoice_lines DROP CONSTRAINT IF EXISTS fiscal_invoice_lines_amounts_check;
ALTER TABLE fiscal_invoice_lines ADD CONSTRAINT fiscal_invoice_lines_amounts_check
  CHECK (base_minor >= 0 AND vat_minor >= 0 AND quantity_milli > 0);

CREATE INDEX IF NOT EXISTS fiscal_invoice_lines_invoice_idx
  ON fiscal_invoice_lines (invoice_id, position);

-- El desglose por alícuota: lo que un documento fiscal declara de verdad.
--
-- Es una tabla y no un campo calculado porque es el dato que se declara, y
-- porque las líneas pueden estar agregadas: con `line_basis = AGGREGATE` hay
-- una sola línea y aun así el desglose tiene que separar el 16% del exento.
CREATE TABLE IF NOT EXISTS fiscal_invoice_taxes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    UUID NOT NULL REFERENCES fiscal_invoices(id) ON DELETE RESTRICT,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,

  tax_category  VARCHAR(16) NOT NULL,
  vat_bps       INTEGER NOT NULL,
  base_minor    BIGINT NOT NULL,
  vat_minor     BIGINT NOT NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE fiscal_invoice_taxes DROP CONSTRAINT IF EXISTS fiscal_invoice_taxes_category_check;
ALTER TABLE fiscal_invoice_taxes ADD CONSTRAINT fiscal_invoice_taxes_category_check
  CHECK (tax_category IN ('TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'));

ALTER TABLE fiscal_invoice_taxes DROP CONSTRAINT IF EXISTS fiscal_invoice_taxes_amounts_check;
ALTER TABLE fiscal_invoice_taxes ADD CONSTRAINT fiscal_invoice_taxes_amounts_check
  CHECK (base_minor >= 0 AND vat_minor >= 0 AND vat_bps >= 0 AND vat_bps <= 10000);

-- Una fila por alícuota y documento. Dos filas al 16% en la misma factura no
-- son un desglose, son un error de construcción.
CREATE UNIQUE INDEX IF NOT EXISTS fiscal_invoice_taxes_rate_idx
  ON fiscal_invoice_taxes (invoice_id, tax_category, vat_bps);

-- ----------------------------------------------- inmutabilidad, en la base

-- Una factura emitida no se toca. Esto no es una convención que la próxima
-- migración pueda olvidar ni una regla que viva sólo en la capa de aplicación:
-- lo rechaza la base de datos, así que también rechaza el UPDATE hecho a mano
-- por alguien con una consola abierta y buena intención.
--
-- Una corrección se hace emitiendo una nota de crédito, que es otra fila.
CREATE OR REPLACE FUNCTION fiscal_document_is_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Los documentos fiscales son inmutables: % sobre % no esta permitido. Una factura emitida se compensa con una nota de credito.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS fiscal_invoices_immutable ON fiscal_invoices;
CREATE TRIGGER fiscal_invoices_immutable
  BEFORE UPDATE OR DELETE ON fiscal_invoices
  FOR EACH ROW EXECUTE FUNCTION fiscal_document_is_immutable();

DROP TRIGGER IF EXISTS fiscal_invoice_lines_immutable ON fiscal_invoice_lines;
CREATE TRIGGER fiscal_invoice_lines_immutable
  BEFORE UPDATE OR DELETE ON fiscal_invoice_lines
  FOR EACH ROW EXECUTE FUNCTION fiscal_document_is_immutable();

DROP TRIGGER IF EXISTS fiscal_invoice_taxes_immutable ON fiscal_invoice_taxes;
CREATE TRIGGER fiscal_invoice_taxes_immutable
  BEFORE UPDATE OR DELETE ON fiscal_invoice_taxes
  FOR EACH ROW EXECUTE FUNCTION fiscal_document_is_immutable();

COMMIT;
