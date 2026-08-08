-- 004_open_bill_invariant.sql
--
-- A restaurant table may have at most one OPEN bill, and a bill's table must
-- belong to the same restaurant as the bill.
--
-- Both matter for the same reason: a physical table QR has to resolve to
-- exactly one current bill. Without the first rule a second bill can be opened
-- for a table that already has one, and nothing can say which is "the" bill.
--
-- If this migration fails because existing data already holds duplicate OPEN
-- bills for a table, reconcile those bills before retrying. The application
-- also locks the table row and checks for an open bill before inserting; this
-- index is the final database-level guarantee behind that check, for the race
-- the application cannot see.

CREATE UNIQUE INDEX IF NOT EXISTS bills_one_open_per_table_idx
  ON bills (restaurant_id, table_id)
  WHERE status = 'OPEN';

COMMENT ON INDEX bills_one_open_per_table_idx IS
  'At most one OPEN bill per restaurant table, so the permanent table QR resolves unambiguously to the current bill.';

-- A composite target is required before (restaurant_id, table_id) can be a
-- foreign key; tables.id alone is already unique, so this adds no real cost.
CREATE UNIQUE INDEX IF NOT EXISTS tables_restaurant_id_id_idx
  ON tables (restaurant_id, id);

-- bills.table_id already references tables(id), but nothing tied the two
-- restaurant_id columns together: a bill could name its own restaurant while
-- pointing at another restaurant's table.
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_table_same_restaurant_fk;
ALTER TABLE bills ADD CONSTRAINT bills_table_same_restaurant_fk
  FOREIGN KEY (restaurant_id, table_id)
  REFERENCES tables (restaurant_id, id)
  ON DELETE RESTRICT;

COMMENT ON CONSTRAINT bills_table_same_restaurant_fk ON bills IS
  'A bill table must belong to the same restaurant as the bill.';
