-- Categoría fiscal por producto, y el IVA calculado por alícuota.
--
-- Hasta aquí una cuenta tenía **un** IVA: `bills.vat_bps`, aplicado de una vez
-- sobre el subtotal entero. Eso da el número correcto mientras todo lo que se
-- vende esté gravado a la misma tasa, y por eso ha bastado. No basta para
-- facturar: un documento fiscal declara base imponible e IVA **por alícuota**, y
-- hay productos que no llevan IVA. Hoy el modelo ni siquiera puede decirlo: la
-- carta no tiene una sola columna de impuestos.
--
-- Esto lo arregla en la carta y en la cuenta, sin tocar lo que ya se cobró.
--
-- Sirva o no la facturación fiscal el día de mañana, esta parte hace falta
-- igual: una máquina fiscal también necesita saber la categoría de cada
-- renglón. Es lo único de la capa fiscal que no depende de qué providencia
-- acabe aplicando.

BEGIN;

-- ---------------------------------------------------------------- la carta

-- Cuatro categorías y no un booleano "lleva IVA".
--
--   TAXABLE      gravado a la alícuota vigente.
--   EXEMPT       exento por la propia ley del impuesto.
--   EXONERATED   exonerado por un acto del Ejecutivo, que tiene fecha de fin.
--   NON_TAXABLE  no sujeto: fuera del ámbito del impuesto.
--
-- Las tres últimas dan cero en la factura, pero **no son la misma cosa** y un
-- libro de ventas las separa. Colapsarlas en "sin IVA" es perder el dato justo
-- cuando alguien lo pide.
ALTER TABLE menu_products
  ADD COLUMN IF NOT EXISTS tax_category VARCHAR(16) NOT NULL DEFAULT 'TAXABLE';

ALTER TABLE menu_products DROP CONSTRAINT IF EXISTS menu_products_tax_category_check;
ALTER TABLE menu_products ADD CONSTRAINT menu_products_tax_category_check
  CHECK (tax_category IN ('TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'));

-- La alícuota propia de este producto, cuando no es la general del restaurante.
-- NULL significa "la del restaurante", que es el caso de casi todo: una columna
-- llena de copias del mismo número se desincroniza a la primera.
ALTER TABLE menu_products
  ADD COLUMN IF NOT EXISTS vat_bps INTEGER;

ALTER TABLE menu_products DROP CONSTRAINT IF EXISTS menu_products_vat_bps_range;
ALTER TABLE menu_products ADD CONSTRAINT menu_products_vat_bps_range
  CHECK (vat_bps IS NULL OR (vat_bps >= 0 AND vat_bps <= 10000));

-- Lo que no está gravado no lleva alícuota propia. Un producto exento con un
-- 16% guardado al lado es una contradicción esperando a que alguien la lea mal.
ALTER TABLE menu_products DROP CONSTRAINT IF EXISTS menu_products_vat_only_when_taxable;
ALTER TABLE menu_products ADD CONSTRAINT menu_products_vat_only_when_taxable
  CHECK (tax_category = 'TAXABLE' OR vat_bps IS NULL);

COMMENT ON COLUMN menu_products.tax_category IS
  'Trato fiscal del producto. EXEMPT, EXONERATED y NON_TAXABLE dan cero IVA y '
  'no son intercambiables: el libro de ventas las declara por separado.';
COMMENT ON COLUMN menu_products.vat_bps IS
  'Alícuota propia en puntos básicos. NULL = la general del restaurante, que es '
  'el caso normal. Sólo puede tener valor un producto gravado.';

-- -------------------------------------------------------------- la cuenta

-- El mismo par, congelado en la línea igual que ya se congela el precio.
--
-- Sin esto, cambiar mañana la categoría de un producto recalcularía el IVA de
-- una cena de anoche. Es exactamente la razón por la que `unit_price_minor`
-- existe, aplicada al impuesto.
ALTER TABLE bill_items
  ADD COLUMN IF NOT EXISTS tax_category VARCHAR(16) NOT NULL DEFAULT 'TAXABLE',
  ADD COLUMN IF NOT EXISTS vat_bps      INTEGER;

ALTER TABLE bill_items DROP CONSTRAINT IF EXISTS bill_items_tax_category_check;
ALTER TABLE bill_items ADD CONSTRAINT bill_items_tax_category_check
  CHECK (tax_category IN ('TAXABLE', 'EXEMPT', 'EXONERATED', 'NON_TAXABLE'));

ALTER TABLE bill_items DROP CONSTRAINT IF EXISTS bill_items_vat_bps_range;
ALTER TABLE bill_items ADD CONSTRAINT bill_items_vat_bps_range
  CHECK (vat_bps IS NULL OR (vat_bps >= 0 AND vat_bps <= 10000));

-- El relleno de las líneas que ya existen: la alícuota que tenía su cuenta.
--
-- Es la que se les aplicó de verdad, así que ninguna cuenta cambia de total al
-- pasar a calcular por alícuota. Y `tax_category` se queda en TAXABLE por
-- defecto, que es lo que eran: todo lo vendido hasta hoy iba gravado, porque no
-- había forma de decir otra cosa.
UPDATE bill_items bi
   SET vat_bps = b.vat_bps
  FROM bills b
 WHERE bi.bill_id = b.id
   AND bi.vat_bps IS NULL;

COMMENT ON COLUMN bill_items.tax_category IS
  'Copia congelada de la categoría fiscal del producto al añadir la línea.';
COMMENT ON COLUMN bill_items.vat_bps IS
  'Copia congelada de la alícuota aplicada a esta línea. Ya resuelta: aquí no '
  'hay NULL que signifique "la del restaurante", porque el restaurante puede '
  'cambiarla y esta cuenta no.';

COMMIT;
