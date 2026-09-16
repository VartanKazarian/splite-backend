-- Numerar nosotros, sin huecos.
--
-- Hasta aquí el número de factura y el de control los ponía una imprenta
-- digital y este código no generaba ninguno, a propósito: inventarlos habría
-- sido falsificar. Con la numeración propia el que responde es el
-- contribuyente, y lo que antes garantizaba un tercero hay que garantizarlo
-- aquí.
--
-- ## Por qué no una SEQUENCE
--
-- Es lo primero que uno alcanza, y es la respuesta equivocada. Una SEQUENCE de
-- Postgres **no es transaccional**, y eso es deliberado: así dos sesiones no se
-- bloquean entre sí. El precio es que un `nextval` seguido de un ROLLBACK deja
-- ese número consumido para siempre.
--
-- Para un id interno da igual. Para un correlativo fiscal no: el libro de
-- ventas tiene que ser continuo, y un hueco es exactamente lo que se pregunta
-- en una fiscalización. «Se cayó la transacción» no es una respuesta que sirva
-- cuando el número que falta es el 1.043.
--
-- Así que un contador en una fila, que se bloquea. Serializa la emisión por
-- restaurante -- dos facturas del mismo local no se numeran a la vez -- y eso
-- es aceptable porque un restaurante emite unas pocas por minuto, y porque el
-- bloqueo ya no abarca ninguna llamada de red: emitiendo nosotros no hay
-- proveedor al que esperar.
--
-- Restaurantes distintos no se estorban: cada uno bloquea su propia fila.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Lo que el SENIAT autorizó. Cambia rara vez y lo escribe una persona.

CREATE TABLE IF NOT EXISTS fiscal_series (
  restaurant_id UUID PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Los prefijos, tal y como aparezcan en la autorización. Se guardan como
  -- texto y no se construyen: si la autorización dice "00-", eso es lo que
  -- tiene que salir impreso, y no una interpretación nuestra.
  control_prefix  VARCHAR(20) NOT NULL DEFAULT '',
  document_prefix VARCHAR(20) NOT NULL DEFAULT '',

  -- A cuántos dígitos se rellena el correlativo. Un número de control suele ir
  -- con ceros a la izquierda y con ancho fijo, y ese ancho es parte de la
  -- identidad del documento: 00-000123 y 00-123 no son el mismo número escrito
  -- de dos formas, son dos documentos distintos para quien los busca.
  pad_to INTEGER NOT NULL DEFAULT 8,

  -- El rango autorizado para el número de **control**. `control_last` nulo
  -- significa sin tope conocido; con tope, emitir el siguiente al último se
  -- rechaza en vez de salirse del rango en silencio.
  control_first BIGINT NOT NULL DEFAULT 1,
  control_last  BIGINT,

  -- La referencia de la autorización, para poder demostrar de dónde sale el
  -- rango sin buscarla en un archivador.
  authorisation_ref VARCHAR(120),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT fiscal_series_pad_range CHECK (pad_to BETWEEN 1 AND 20),
  CONSTRAINT fiscal_series_first_positive CHECK (control_first >= 1),
  CONSTRAINT fiscal_series_range_ordered
    CHECK (control_last IS NULL OR control_last >= control_first)
);

COMMENT ON TABLE fiscal_series IS
  'El rango y el formato que el SENIAT autorizó a este contribuyente. Lo '
  'escribe una persona y tiene que coincidir con la autorización: aquí no se '
  'inventa ni se deduce nada.';

-- ---------------------------------------------------------------------------
-- 2. Por dónde va cada contador. Cambia en cada factura.

CREATE TABLE IF NOT EXISTS fiscal_counters (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- 'CONTROL' para el número de control, que es único en todos los documentos
  -- del contribuyente. Uno por tipo de documento para el número de documento
  -- ('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE'), porque cada clase lleva su
  -- propia correlatividad.
  --
  -- Texto libre y no un enum: el enum habría que migrarlo para añadir una
  -- clase de documento, y esta columna no decide nada -- sólo separa
  -- contadores.
  scope VARCHAR(30) NOT NULL,

  -- El próximo a repartir. Se lee y se incrementa con la fila bloqueada,
  -- dentro de la transacción que escribe el documento.
  next_value BIGINT NOT NULL,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (restaurant_id, scope),
  CONSTRAINT fiscal_counters_positive CHECK (next_value >= 1)
);

COMMENT ON TABLE fiscal_counters IS
  'Un contador por restaurante y ámbito. Se reparte con SELECT ... FOR UPDATE '
  'dentro de la transacción del documento: sin huecos, a costa de serializar '
  'la emisión de cada restaurante consigo mismo.';

-- ---------------------------------------------------------------------------
-- 3. La unicidad que hace que el hueco sea lo único que haya que vigilar
--
-- Que no se repitan ya no depende de que el código esté bien. Dos documentos
-- del mismo restaurante no pueden compartir número de control ni, dentro de su
-- clase, número de documento -- lo diga quien lo diga.
--
-- Sobre `fiscal_invoices`, que es inmutable: estos índices sólo pueden
-- rechazar inserciones, que es justo lo que se quiere.

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_invoices_control_unique_idx
  ON fiscal_invoices (restaurant_id, control_number);

CREATE UNIQUE INDEX IF NOT EXISTS fiscal_invoices_document_unique_idx
  ON fiscal_invoices (restaurant_id, document_type, document_number);

-- ---------------------------------------------------------------------------
-- 4. Y la unicidad que había antes, que con emisión propia es falsa
--
-- 039 dejó un índice único por `(provider, control_number)`, y con imprenta
-- digital era una descripción correcta: el número lo ponía el proveedor, la
-- serie era suya y no se repetía entre sus clientes.
--
-- Emitiendo nosotros todos los restaurantes comparten el mismo `provider`
-- ('own'), así que ese índice pasa a decir que **dos contribuyentes no pueden
-- llevar el mismo número de control**. Es falso: el correlativo es de cada
-- contribuyente y cada uno lo lleva en su propio libro. Dos locales con
-- autorizaciones distintas tienen los dos su número 1, y los dos tienen razón.
--
-- Medido antes de quitarlo: dos restaurantes recién dados de alta, cada uno con
-- su serie empezando en 1, y el segundo no podía emitir -- 23505 contra este
-- índice, sin nada que arreglar en su autorización, porque era correcta.
--
-- Se cae y lo sustituye el de arriba, que es la regla de verdad. No se pierde
-- ninguna garantía por el camino del proveedor: `(restaurant_id,
-- control_number)` también impide allí que un documento repita número.

DROP INDEX IF EXISTS fiscal_invoices_control_idx;

COMMIT;
