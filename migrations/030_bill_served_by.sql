-- Whose table this is.
--
-- Tips have been recorded per payment since migration 024, and reported per
-- shift since. What has never existed is any link between a bill and the person
-- who served it -- so the tips report could tell a restaurant what it owed its
-- staff in total, and could not tell any individual member of staff what they
-- had earned.
--
-- That is the half that changes behaviour. A pooled figure a manager reads once
-- a week is an accounting line; a number a waiter can see climbing during their
-- own shift is an incentive, which is the reason to build tipping into the
-- product at all.
--
-- Nullable, and deliberately so. Bills that predate this column have no server
-- and must not pretend to: attributing historical tips to whoever happens to be
-- convenient would put money against a name on no evidence. They report under a
-- null server and are visible as unattributed.
--
-- Set from whoever opens the bill, which is right whenever the person taking
-- the order is the person who opens it, and wrong wherever a host or a cashier
-- opens bills on somebody else's behalf -- which is common enough that it needs
-- a correction path rather than an assumption. PATCH /bills/:id/server is that
-- path, restricted to OWNER and MANAGER and audited, because it moves money
-- between people.
--
-- Reassignment is retroactive on purpose. Attribution is read through the
-- bill's *current* server, so correcting a mistake corrects the tips that
-- followed from it. A correction that left yesterday's tips against the wrong
-- name would not be a correction.

-- Composite key first, so the column below can carry a tenant-scoped foreign
-- key rather than trusting the restaurant_id written beside it. Same pattern as
-- migrations 016 and 029.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_restaurant_idx
  ON users (id, restaurant_id);

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS served_by UUID;

ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_served_by_fk;
ALTER TABLE bills
  ADD CONSTRAINT bills_served_by_fk
  FOREIGN KEY (served_by, restaurant_id) REFERENCES users (id, restaurant_id)
  -- A member of staff who leaves is deleted or deactivated; their bills stay,
  -- and the money on them stays. SET NULL rather than RESTRICT so removing
  -- somebody is never blocked by a bill they once served, and never CASCADE,
  -- which would delete the bill and the ledger under it.
  --
  -- The column list is load-bearing. A plain ON DELETE SET NULL on a *composite*
  -- foreign key nulls every referencing column, which here means
  -- bills.restaurant_id -- so deleting a member of staff would try to blank the
  -- tenant off their tables. The NOT NULL on that column turns it into a
  -- refusal rather than corruption, which is how this was found: deleting a
  -- user started failing with "null value in column restaurant_id". Naming the
  -- column nulls only the attribution, which is the whole intent.
  ON DELETE SET NULL (served_by);

-- "What did this person earn" is the query, so the server is the leading column
-- after the tenant. Partial, because a bill with no server is the uninteresting
-- majority of history and does not belong in the index that answers it.
CREATE INDEX IF NOT EXISTS bills_served_by_idx
  ON bills (restaurant_id, served_by)
  WHERE served_by IS NOT NULL;

COMMENT ON COLUMN bills.served_by IS
  'The member of staff this bill is attributed to, for tips. Set from whoever opened it and correctable by a manager; read through for attribution, so a correction moves the tips with it.';
