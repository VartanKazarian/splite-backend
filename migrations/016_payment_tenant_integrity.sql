-- A payment cannot name one restaurant and point at another's bill.
--
-- Migration 004 closed this for bills and tables, with the reasoning that
-- applies unchanged one level down: restaurant_id and the foreign key beside it
-- are two independent columns, so nothing stops a row claiming its own
-- restaurant while referencing a different one's record. The ledger was left
-- with that gap on both of its tables.
--
--   payments            restaurant_id -> restaurants,  bill_id    -> bills
--   payment_transitions restaurant_id -> restaurants,  payment_id -> payments
--
-- No row has ever been written that way, because every write path re-reads the
-- bill under `WHERE id = $1 AND restaurant_id = $2` before touching it -- the
-- staff split, the confirmed Pago Móvil claim and the webhook all go through
-- `applyToBill`, which does exactly that. But that is discipline in application
-- code, not a guarantee, and the whole point of the constraint in 004 was that
-- the database should not depend on every future caller remembering.
--
-- This is a money table. The failure it prevents is a payment recorded against
-- the wrong tenant's bill, which is both a settlement error and a cross-tenant
-- data leak, and it is the kind that is discovered by an accountant rather than
-- by a test.
--
-- These constraints are added VALIDATED, so applying this migration fails if any
-- existing row breaks them. That is the intended behaviour: a violation here
-- means real money is attributed to the wrong restaurant, and a deploy that
-- carried on regardless would bury it.

-- A composite target is required before (bill_id, restaurant_id) can be a
-- foreign key. `bills.id` alone is already unique, so this index adds no real
-- constraint -- only the shape Postgres needs to reference the pair.
--
-- The existing bills_id_restaurant_currency_idx cannot serve: a foreign key
-- must reference exactly the columns of a unique constraint, and a three-column
-- index does not satisfy a two-column reference.
CREATE UNIQUE INDEX IF NOT EXISTS bills_id_restaurant_idx
  ON bills (id, restaurant_id);

CREATE UNIQUE INDEX IF NOT EXISTS payments_id_restaurant_idx
  ON payments (id, restaurant_id);

-- The single-column foreign keys stay, matching what 004 did for bills: the
-- composite implies them, but they carry the ON DELETE RESTRICT that keeps a
-- payment from vanishing because its bill was deleted, and removing them to
-- avoid a redundant check would be trading a stated rule for a tidier schema.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_bill_same_restaurant_fk;
ALTER TABLE payments ADD CONSTRAINT payments_bill_same_restaurant_fk
  FOREIGN KEY (bill_id, restaurant_id)
  REFERENCES bills (id, restaurant_id)
  ON DELETE RESTRICT;

ALTER TABLE payment_transitions DROP CONSTRAINT IF EXISTS payment_transitions_payment_same_restaurant_fk;
ALTER TABLE payment_transitions ADD CONSTRAINT payment_transitions_payment_same_restaurant_fk
  FOREIGN KEY (payment_id, restaurant_id)
  REFERENCES payments (id, restaurant_id)
  ON DELETE RESTRICT;

COMMENT ON CONSTRAINT payments_bill_same_restaurant_fk ON payments IS
  'A payment and the bill it settles belong to the same restaurant. Enforced '
  'here rather than trusted to every caller, as in bills_table_same_restaurant_fk.';
