-- 032_menu_pdf.sql
--
-- The restaurant's own menu, as the file they already have.
--
-- Everything so far assumed a menu worth transcribing: OCR reads a photo,
-- somebody corrects the draft, and the result is a priced list Splite can group
-- into sections and put on a bill. That is the right shape for a menu the
-- kitchen changes, and it is a lot of work for a restaurant whose menu is a PDF
-- their designer sent them and which changes twice a year.
--
-- So: let them upload the PDF and have the QR show it. It does not replace the
-- structured menu -- a bill still needs priced products -- but it means a
-- restaurant can put something real in front of a diner on day one, before
-- anybody has typed in a single price.

-- A table of its own rather than columns on `restaurants`, because of what is
-- stored: the bytes. A bytea on the restaurant row travels with every query
-- that forgets to name its columns, and the restaurant row is read on nearly
-- every request. Out here it is touched only by the two routes that want it.
CREATE TABLE IF NOT EXISTS menu_documents (
  -- One per restaurant, so the primary key is the tenant. Replacing the menu is
  -- an upsert rather than a second row plus a rule about which one wins.
  restaurant_id UUID PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,

  bytes BYTEA NOT NULL,

  -- What the diner's browser is told. Kept rather than assumed: the upload
  -- route accepts one type today, and a stored file should still describe
  -- itself if that ever widens.
  content_type TEXT NOT NULL,

  -- The name the restaurant's own file had. Shown in the panel so somebody can
  -- tell "carta-2026.pdf" from "carta-vieja.pdf" without opening both.
  filename TEXT NOT NULL,

  -- Denormalised so the panel and the public menu can say how big it is, and
  -- decide whether to embed it or link to it, without reading the bytes.
  size_bytes INT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A PDF is not a place to put an arbitrary payload. The route enforces the
  -- same ceiling and rejects with a clear error; this is the backstop for
  -- anything that reaches the table another way.
  CONSTRAINT menu_documents_size_sane CHECK (size_bytes > 0 AND size_bytes <= 20971520),
  CONSTRAINT menu_documents_size_matches CHECK (size_bytes = octet_length(bytes))
);

DROP TRIGGER IF EXISTS menu_documents_set_updated_at ON menu_documents;
CREATE TRIGGER menu_documents_set_updated_at BEFORE UPDATE ON menu_documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE menu_documents IS
  'The restaurant''s menu as an uploaded file, shown to diners from the table QR. One per restaurant. Does not replace menu_products, which is what a bill is built from.';
COMMENT ON COLUMN menu_documents.size_bytes IS
  'Kept in step with the bytes by CHECK, so a listing can report the size without reading the file.';
