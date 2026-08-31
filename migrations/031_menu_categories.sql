-- 031_menu_categories.sql
--
-- The sections a menu is already divided into.
--
-- The vision reader has always asked for them -- `section` is in the extraction
-- prompt, and every draft it returns carries one -- but there was nowhere to
-- put the answer, so the import dropped it and a restaurant's own structure
-- arrived as one alphabetical list. Entradas, Principales and Postres came back
-- interleaved with each other, which is not a menu; it is an inventory.
--
-- A table rather than a `category` column on the product, for one reason:
-- order. A menu runs starters, mains, desserts, and a text column can only sort
-- alphabetically -- Bebidas, Entradas, Postres, Principales -- which is wrong
-- everywhere and cannot be corrected. `position` is the whole point, and it
-- belongs to the category rather than being repeated on every product in it.

CREATE TABLE IF NOT EXISTS menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  name VARCHAR(80) NOT NULL,

  -- Where the section sits on the menu. Assigned from the order sections first
  -- appear in an import, which is the order they were printed in -- the reader
  -- walks the page top to bottom, so first-seen is the menu's own sequence.
  position INT NOT NULL DEFAULT 0,

  -- A whole section off the menu: the kitchen has run out of fish. Distinct
  -- from deleting it, which would orphan its products.
  active BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Case-sensitively unique is not enough: a reader that returns "Bebidas" on
  -- one page and "BEBIDAS" on another would create two sections for one, and
  -- the import cannot tell that it has.
  UNIQUE (restaurant_id, name),

  -- The target of the composite foreign key below. A plain REFERENCES
  -- menu_categories(id) would let one restaurant file its food under another
  -- restaurant's section: the id exists, and nothing in the constraint says
  -- whose it is. 016_payment_tenant_integrity made the same correction to
  -- payments, and for the same reason.
  UNIQUE (id, restaurant_id)
);

CREATE INDEX IF NOT EXISTS menu_categories_restaurant_position_idx
  ON menu_categories (restaurant_id, position, name);

-- 002_phase1_hardening moved updated_at maintenance into the database rather
-- than leaving it to every call site; a new table follows the same rule.
DROP TRIGGER IF EXISTS menu_categories_set_updated_at ON menu_categories;
CREATE TRIGGER menu_categories_set_updated_at BEFORE UPDATE ON menu_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE menu_products
  -- Nullable, and staying that way. Products created before this migration have
  -- no section, and a menu photo with no printed headings yields none either --
  -- both are "uncategorised", which is a real state and not a missing value to
  -- be backfilled with a guess.
  ADD COLUMN IF NOT EXISTS category_id UUID NULL,

  -- Order within the section, same reasoning as the category's own position.
  ADD COLUMN IF NOT EXISTS position INT NOT NULL DEFAULT 0;

-- Tenant-safe by construction: the pair (category_id, restaurant_id) must exist
-- on menu_categories, so a category belonging to another restaurant cannot be
-- referenced however the id was obtained. Nothing in the route has to remember
-- to check it.
--
-- ON DELETE SET NULL *names the column*, and must. On a composite key the
-- unqualified form nulls every referencing column, which here would blank
-- menu_products.restaurant_id -- the tenant off the product -- when a section
-- was deleted. 030_bill_served_by hit exactly that and the NOT NULL turned it
-- into a refusal rather than corruption; this one is spelled correctly from the
-- start. Deleting a section leaves its food uncategorised, still sellable.
ALTER TABLE menu_products DROP CONSTRAINT IF EXISTS menu_products_category_fk;
ALTER TABLE menu_products ADD CONSTRAINT menu_products_category_fk
  FOREIGN KEY (category_id, restaurant_id)
  REFERENCES menu_categories (id, restaurant_id)
  ON DELETE SET NULL (category_id);

-- The listing order, for both the staff list and the public menu: section, then
-- position inside it, then name as the tie-break for everything imported at
-- once with position 0.
CREATE INDEX IF NOT EXISTS menu_products_restaurant_category_idx
  ON menu_products (restaurant_id, category_id, position, name);

COMMENT ON TABLE menu_categories IS
  'Menu sections. Ordered by position; a product with a NULL category_id is uncategorised and sorts last.';
COMMENT ON COLUMN menu_categories.position IS
  'Order on the menu. Taken from the order sections first appear in an OCR import, which is the printed order.';
COMMENT ON COLUMN menu_products.category_id IS
  'Section this product sits under, or NULL for uncategorised. ON DELETE SET NULL: removing a section must not remove its food.';
