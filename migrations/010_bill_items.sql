-- Bill line items, with immutable price snapshots.
--
-- A bill has carried a total and nothing else, so a restaurant could not be
-- told what was ordered and no split could be finer than "divide by n". This
-- adds the lines, and the rule that makes them trustworthy: what a line cost is
-- copied when it is added and never read from the menu again.
--
-- Re-pricing a product, renaming it or deactivating it must not change a bill
-- that has already been served. product_id is kept for reporting only, and is
-- deliberately nullable -- the snapshot is the truth, so an item outlives the
-- product it came from.

-- The FK target below. bills.id is already unique on its own; this composite
-- exists so a line item can be tied to its tenant *and* its currency in one
-- constraint, letting the database reject both a cross-tenant item and an item
-- priced in a currency the bill does not settle in.
CREATE UNIQUE INDEX IF NOT EXISTS bills_id_restaurant_currency_idx
  ON bills (id, restaurant_id, currency);

CREATE TABLE IF NOT EXISTS bill_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL REFERENCES bills(id) ON DELETE CASCADE,

  -- ON DELETE SET NULL, not RESTRICT: menu products are soft-deleted today, but
  -- an item must survive a product disappearing by any route. Everything needed
  -- to render and total the line is snapshotted below.
  product_id UUID REFERENCES menu_products(id) ON DELETE SET NULL,

  -- The snapshot. Taken from the product when the line is added.
  name_snapshot VARCHAR(160) NOT NULL,
  unit_price_minor BIGINT NOT NULL CHECK (unit_price_minor >= 0),
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('VES','USD','EUR')),

  -- 999 is arbitrary but bounded: quantity multiplies into subtotal_minor, and
  -- an unbounded integer there is how a BIGINT overflow becomes a failed insert
  -- in the middle of a service.
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 999),

  -- Generated, not maintained. Storing a subtotal that application code keeps
  -- in step with unit_price_minor * quantity is exactly the drift the payment
  -- ledger exists to remove; the database computes it or nothing does.
  subtotal_minor BIGINT GENERATED ALWAYS AS (unit_price_minor * quantity) STORED,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ties the line to its bill, its tenant and its currency at once. Without the
  -- currency leg a EUR line could sit on a USD bill and the total would be the
  -- sum of two different units.
  CONSTRAINT bill_items_bill_tenant_currency_fk
    FOREIGN KEY (bill_id, restaurant_id, currency)
    REFERENCES bills (id, restaurant_id, currency)
    ON DELETE CASCADE,

  -- A product may appear on the same bill more than once (a second round is a
  -- second line), so there is deliberately no uniqueness on (bill_id, product_id).
  CONSTRAINT bill_items_name_not_blank CHECK (length(btrim(name_snapshot)) > 0)
);

CREATE INDEX IF NOT EXISTS bill_items_bill_id_idx ON bill_items (bill_id, created_at);
CREATE INDEX IF NOT EXISTS bill_items_product_id_idx ON bill_items (product_id) WHERE product_id IS NOT NULL;

DROP TRIGGER IF EXISTS bill_items_set_updated_at ON bill_items;
CREATE TRIGGER bill_items_set_updated_at BEFORE UPDATE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE bill_items IS
  'Bill line items. Prices are snapshotted on insert; changing the menu never alters an existing bill.';
COMMENT ON COLUMN bill_items.product_id IS
  'Reporting link only, nullable. name_snapshot and unit_price_minor are authoritative.';
COMMENT ON COLUMN bill_items.subtotal_minor IS
  'Generated: unit_price_minor * quantity. Never written by the application.';
