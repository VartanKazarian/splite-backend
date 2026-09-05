-- 034_restaurant_branding.sql
--
-- The restaurant's own face: a cover photo and a logo.
--
-- A diner who scans the code sees a page that says the restaurant's name in the
-- app's typeface and nothing else. Every pay-at-table product they are compared
-- to opens on the restaurant -- its front, its logo -- because that is what
-- tells somebody the code they just scanned belongs to the place they are
-- sitting in, before they read a word.
--
-- Two images rather than one, because they are used differently and cropped
-- differently: the cover is wide and sits behind the name, the logo is square
-- and sits on top of it.

-- Same shape as menu_product_images (migration 033) and for the same reasons:
-- the bytes live away from the row everything else reads. `restaurants` is
-- selected on nearly every authenticated request, and a bytea column there
-- would ride along with each one.
CREATE TABLE IF NOT EXISTS restaurant_images (
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  -- Which of the two. The pair is the key, so replacing either is an upsert
  -- rather than a second row plus a rule about which one wins.
  kind TEXT NOT NULL,

  bytes BYTEA NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INT NOT NULL,

  -- The ETag, computed once at upload rather than per request, and the reason a
  -- replaced image reaches a phone that already cached the old one: it goes on
  -- the query string, so a new picture is a new address. See migration 033.
  checksum TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (restaurant_id, kind),

  CONSTRAINT restaurant_images_kind_known CHECK (kind IN ('COVER', 'LOGO')),
  -- Not a place to put an arbitrary payload. The route enforces the same
  -- ceiling and rejects with a clear error; this is the backstop for anything
  -- that reaches the table another way.
  CONSTRAINT restaurant_images_size_sane CHECK (size_bytes > 0 AND size_bytes <= 5242880),
  CONSTRAINT restaurant_images_size_matches CHECK (size_bytes = octet_length(bytes)),
  CONSTRAINT restaurant_images_type_supported
    CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp'))
);

DROP TRIGGER IF EXISTS restaurant_images_set_updated_at ON restaurant_images;
CREATE TRIGGER restaurant_images_set_updated_at BEFORE UPDATE ON restaurant_images
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE restaurant_images IS
  'The cover photo and logo shown to a diner who scans a table QR. Kept out of restaurants so the bytes cannot ride along with the row every request reads.';
