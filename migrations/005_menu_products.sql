-- 005_menu_products.sql
--
-- A restaurant configures the currency its menu is priced in, and holds a list
-- of products at prices in that currency.
--
-- This does not change how bills settle. Splite settlement is always VES; the
-- menu currency only says what the printed prices are denominated in. Bills
-- gain their VES conversion and FX snapshot in a later migration, so nothing
-- here touches the bills table.

ALTER TABLE restaurants
  ADD COLUMN IF NOT EXISTS menu_currency VARCHAR(3) NOT NULL DEFAULT 'VES';

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_menu_currency_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_menu_currency_check
  CHECK (menu_currency IN ('VES','USD','EUR'));

CREATE TABLE IF NOT EXISTS menu_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500),
  price_minor_units BIGINT NOT NULL CHECK (price_minor_units >= 0),
  currency VARCHAR(3) NOT NULL CHECK (currency IN ('VES','USD','EUR')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (restaurant_id, name)
);

CREATE INDEX IF NOT EXISTS menu_products_restaurant_active_idx
  ON menu_products (restaurant_id, active, name);

-- 002_phase1_hardening moved updated_at maintenance into the database rather
-- than leaving it to every call site; a new table follows the same rule.
DROP TRIGGER IF EXISTS menu_products_set_updated_at ON menu_products;
CREATE TRIGGER menu_products_set_updated_at BEFORE UPDATE ON menu_products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON COLUMN restaurants.menu_currency IS
  'Currency the menu is priced in. Splite settlement is always VES regardless of this value.';
COMMENT ON COLUMN menu_products.currency IS
  'Copied from the restaurant menu currency at creation. Changing the menu currency requires no active product to disagree with it.';
