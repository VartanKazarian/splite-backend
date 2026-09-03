-- 033_product_images.sql
--
-- A photograph of the dish.
--
-- A menu that is a list of names and prices asks a diner to already know what
-- "cachapa con cochino" looks like. Every pay-at-table product a restaurant
-- compares us to shows the food, and the reason is not decoration: a photo is
-- what makes a diner order the thing they have not had before, and it is what
-- makes the QR menu feel like the restaurant rather than like a spreadsheet.
--
-- Optional, per product, and always the restaurant's choice. A menu with no
-- photographs must keep looking deliberate rather than unfinished, because most
-- of them will start that way and some will stay that way.

-- The composite target the photo's foreign key needs, created first because the
-- table below references it. menu_products.id is already unique on its own, so
-- this adds no real constraint -- only the two-column shape Postgres requires to
-- reference the pair, exactly as migrations 016 and 020 did for bills and bill
-- items.
CREATE UNIQUE INDEX IF NOT EXISTS menu_products_id_restaurant_idx
  ON menu_products (id, restaurant_id);

-- Its own table, not a column on menu_products, for the reason migration 032
-- gave for menu_documents: the bytes. A bytea on the product row travels with
-- every `SELECT *` and every menu listing -- the exact query a diner's phone
-- makes -- and one forgotten column list would put a megabyte per dish on the
-- wire. Out here it is touched only by the routes that want the file.
CREATE TABLE IF NOT EXISTS menu_product_images (
  -- One per product, so replacing a photo is an upsert rather than a second row
  -- plus a rule about which one wins.
  product_id UUID PRIMARY KEY REFERENCES menu_products(id) ON DELETE CASCADE,

  -- Carried so the tenant is on the row itself. Every other table here can be
  -- scoped without a join, and a public route that serves bytes is the last
  -- place to make an exception: the check that a photo belongs to the
  -- restaurant being asked about should not depend on remembering to join.
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  bytes BYTEA NOT NULL,

  -- What the diner's browser is told. Kept rather than assumed: three types are
  -- accepted and they are not interchangeable.
  content_type TEXT NOT NULL,

  -- Denormalised so a listing can report the size without reading the file.
  size_bytes INT NOT NULL,

  -- The ETag, computed once at upload rather than per request. A dish photo is
  -- fetched by every diner in the room on every visit, and hashing a megabyte
  -- on each of those requests to decide whether to send it would cost more than
  -- sending it. Its second job is telling two uploads apart: replacing a photo
  -- changes this, so a phone holding the old one is told to fetch again.
  checksum TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The product belongs to the same tenant as the photo. Without this a photo
  -- could be attached across restaurants by id, and the route serving it would
  -- be the only thing standing in the way.
  CONSTRAINT menu_product_images_product_same_restaurant_fk
    FOREIGN KEY (product_id, restaurant_id) REFERENCES menu_products (id, restaurant_id)
    ON DELETE CASCADE,

  -- A photo is not a place to put an arbitrary payload. The route enforces the
  -- same ceiling and rejects with a clear error; this is the backstop for
  -- anything that reaches the table another way.
  CONSTRAINT menu_product_images_size_sane CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  CONSTRAINT menu_product_images_size_matches CHECK (size_bytes = octet_length(bytes)),
  CONSTRAINT menu_product_images_type_supported
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp'))
);

-- The public menu asks "which of these products have a photo?" for a whole
-- restaurant at once, and must answer it without touching the bytes.
CREATE INDEX IF NOT EXISTS menu_product_images_restaurant_idx
  ON menu_product_images (restaurant_id);

DROP TRIGGER IF EXISTS menu_product_images_set_updated_at ON menu_product_images;
CREATE TRIGGER menu_product_images_set_updated_at BEFORE UPDATE ON menu_product_images
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE menu_product_images IS
  'An optional photograph per product, shown on the QR menu. Kept out of menu_products so the bytes cannot ride along with a menu listing.';
COMMENT ON COLUMN menu_product_images.checksum IS
  'The ETag, computed at upload. Lets a repeat visit be answered with 304 without hashing the file again, and changes when the photo is replaced.';
