-- Persistent bill splits, tied to the ledger.
--
-- Until now a split was advisory: services/splitEngine.js computed who owed
-- what and returned it, and nothing was stored. A diner read their share and
-- paid it through the ordinary payment path, where CHECK (amount_paid_ves <=
-- total_due_ves) was the only thing standing between them and an overpaid bill.
--
-- That leaves two things impossible. A group cannot agree a split and have it
-- persist across their phones, and nothing stops one diner paying more than
-- their agreed share and leaving another unable to pay theirs at all -- the
-- bill-level ceiling permits it, because at the bill level the money is fine.
--
-- This makes a split a stored plan whose shares sum, by construction, to the
-- outstanding balance at the moment it was agreed, and ties each payment that
-- cites a share to that share's own ceiling. The two invariants are enforced
-- here rather than in the service, for the reason the rest of this schema is:
-- the database should not depend on every future caller remembering.
--
--   1. The shares of a split sum to its basis. A deferred constraint trigger,
--      so all participant rows land in one transaction before it checks.
--   2. A share is never overpaid. A row CHECK, the exact analogue of the
--      bill-level one, one level down.
--
-- What this deliberately does NOT do: make the split the only way to pay. Cash
-- at the till still settles the bill outside any split, and the bill-level
-- ceiling still governs that. A split is a plan for who pays which part; it is
-- not a second source of truth for how much the bill has been paid. That stays
-- bills.amount_paid_ves, maintained by applyToBill as before.

-- ---------------------------------------------------------------------------
-- 1. The split

CREATE TABLE IF NOT EXISTS bill_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- RESTRICT for the same reason the ledger uses it: a split is a record of an
  -- agreement about money, and must not vanish because a bill or restaurant row
  -- was deleted out from under it.
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  bill_id UUID NOT NULL,

  mode VARCHAR(10) NOT NULL CHECK (mode IN ('FULL', 'EQUAL', 'ITEMS', 'CUSTOM')),

  -- The outstanding VES balance at the instant the split was agreed: products,
  -- VAT and service charge, less whatever was already paid. The shares sum to
  -- exactly this. Frozen here rather than recomputed, because the outstanding
  -- balance moves as the bill is paid and the plan must not move with it.
  basis_ves BIGINT NOT NULL CHECK (basis_ves > 0),

  status VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'VOID')),

  -- Who agreed it. A guest split has no user id.
  created_by_type VARCHAR(10) NOT NULL CHECK (created_by_type IN ('STAFF', 'GUEST')),
  created_by_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Referenced as a pair by the child tables, so tenant isolation is a foreign
  -- key rather than a discipline (migration 016).
  CONSTRAINT bill_splits_id_restaurant_unique UNIQUE (id, restaurant_id),

  CONSTRAINT bill_splits_bill_same_restaurant_fk
    FOREIGN KEY (bill_id, restaurant_id) REFERENCES bills (id, restaurant_id)
    ON DELETE RESTRICT
);

-- One live plan per bill. A group that changes its mind voids the current split
-- and agrees another; two ACTIVE splits would be two answers to "who owes what".
CREATE UNIQUE INDEX IF NOT EXISTS bill_splits_one_active_per_bill
  ON bill_splits (bill_id) WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS bill_splits_bill_idx
  ON bill_splits (restaurant_id, bill_id, created_at DESC);

DROP TRIGGER IF EXISTS bill_splits_set_updated_at ON bill_splits;
CREATE TRIGGER bill_splits_set_updated_at BEFORE UPDATE ON bill_splits
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. The participants and their shares

CREATE TABLE IF NOT EXISTS bill_split_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  split_id UUID NOT NULL,

  -- The label the diner typed in the split request ("Ana"), echoed back so a
  -- client can map its own participants to the persisted rows, and so an ITEMS
  -- claim can name them. Not a principal: a participant is a share of a bill,
  -- not a Splite account. Unique within a split so two shares cannot hide
  -- behind one label.
  ext_ref VARCHAR(64) NOT NULL,
  name VARCHAR(80),

  -- The assigned share, frozen. Zero is legal: an ITEMS participant who claimed
  -- nothing owes nothing, which is an answer rather than an error.
  amount_ves BIGINT NOT NULL CHECK (amount_ves >= 0),

  -- How much of the share has settled. The ceiling is the whole point of tying
  -- a split to the ledger: the exact analogue, one level down, of the
  -- bill-level overpayment CHECK.
  amount_paid_ves BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid_ves >= 0),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT bill_split_participants_id_restaurant_unique UNIQUE (id, restaurant_id),
  CONSTRAINT bill_split_participants_ext_ref_unique UNIQUE (split_id, ext_ref),

  -- A share is never paid beyond what it owes.
  CONSTRAINT bill_split_participants_not_overpaid CHECK (amount_paid_ves <= amount_ves),

  CONSTRAINT bill_split_participants_split_same_restaurant_fk
    FOREIGN KEY (split_id, restaurant_id) REFERENCES bill_splits (id, restaurant_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bill_split_participants_split_idx
  ON bill_split_participants (split_id);

DROP TRIGGER IF EXISTS bill_split_participants_set_updated_at ON bill_split_participants;
CREATE TRIGGER bill_split_participants_set_updated_at BEFORE UPDATE ON bill_split_participants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The share is immutable once agreed; only its paid figure moves. Correcting a
-- share is voiding the split and agreeing another, not editing a row, so the
-- sum invariant established at creation can never be silently broken afterwards.
CREATE OR REPLACE FUNCTION bill_split_participants_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.amount_ves IS DISTINCT FROM OLD.amount_ves THEN
    RAISE EXCEPTION 'bill_split_participants.amount_ves is immutable (participant %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.split_id IS DISTINCT FROM OLD.split_id THEN
    RAISE EXCEPTION 'bill_split_participants.split_id is immutable (participant %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bill_split_participants_guard ON bill_split_participants;
CREATE TRIGGER bill_split_participants_guard BEFORE UPDATE ON bill_split_participants
  FOR EACH ROW EXECUTE FUNCTION bill_split_participants_guard();

-- The shares of a split sum to its basis.
--
-- A DEFERRABLE INITIALLY DEFERRED constraint trigger: the check runs once at
-- commit, after every participant row of a newly created split is in place,
-- rather than after each insert when the running total is meaningless. A split
-- whose shares do not add up to the balance it claims to divide is refused at
-- commit, whole.
CREATE OR REPLACE FUNCTION bill_splits_assert_shares_sum() RETURNS TRIGGER AS $$
DECLARE
  target_split UUID := COALESCE(NEW.split_id, OLD.split_id);
  split_basis BIGINT;
  share_total BIGINT;
  split_status TEXT;
BEGIN
  SELECT basis_ves, status INTO split_basis, split_status
    FROM bill_splits WHERE id = target_split;

  -- The split was voided (or removed) in the same transaction: nothing to
  -- assert about a plan that no longer stands.
  IF split_basis IS NULL OR split_status <> 'ACTIVE' THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(SUM(amount_ves), 0) INTO share_total
    FROM bill_split_participants WHERE split_id = target_split;

  IF share_total <> split_basis THEN
    RAISE EXCEPTION 'split % shares sum to % but its basis is %', target_split, share_total, split_basis
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bill_split_participants_sum_check ON bill_split_participants;
CREATE CONSTRAINT TRIGGER bill_split_participants_sum_check
  AFTER INSERT OR UPDATE OR DELETE ON bill_split_participants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION bill_splits_assert_shares_sum();

-- ---------------------------------------------------------------------------
-- 3. ITEMS claims
--
-- Only for ITEMS splits: which participant(s) claimed which line. Kept as
-- evidence of how the shares were derived -- when a diner disputes their share,
-- this is the answer -- and deliberately whole-line: a line is claimed by one
-- or more people and split evenly, matching the engine. Per-quantity assignment
-- is a later phase and would add a quantity column here.

-- A composite target for the claim's foreign key. bill_items.id is already
-- unique on its own, so this adds no real constraint -- only the two-column
-- shape Postgres requires to reference the pair, exactly as migration 016 did
-- for bills.
CREATE UNIQUE INDEX IF NOT EXISTS bill_items_id_restaurant_idx
  ON bill_items (id, restaurant_id);

CREATE TABLE IF NOT EXISTS bill_split_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  split_id UUID NOT NULL,
  bill_item_id UUID NOT NULL,
  participant_id UUID NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One claim row per (line, participant) within a split: a person claims a
  -- line once, whole.
  CONSTRAINT bill_split_items_unique UNIQUE (split_id, bill_item_id, participant_id),

  CONSTRAINT bill_split_items_split_same_restaurant_fk
    FOREIGN KEY (split_id, restaurant_id) REFERENCES bill_splits (id, restaurant_id)
    ON DELETE CASCADE,
  -- The line belongs to the same tenant, and (below) to the split's bill.
  CONSTRAINT bill_split_items_item_same_restaurant_fk
    FOREIGN KEY (bill_item_id, restaurant_id) REFERENCES bill_items (id, restaurant_id)
    ON DELETE CASCADE,
  CONSTRAINT bill_split_items_participant_same_restaurant_fk
    FOREIGN KEY (participant_id, restaurant_id) REFERENCES bill_split_participants (id, restaurant_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bill_split_items_split_idx
  ON bill_split_items (split_id);

-- ---------------------------------------------------------------------------
-- 4. Attributing a payment to a share
--
-- Nullable: most payments settle the bill without naming a share, and those are
-- untouched. When it is set, the settling transaction advances that share's
-- amount_paid_ves under the CHECK above -- see src/services/payments.js, which
-- does it at the one point every rail's settlement passes through.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS split_participant_id UUID;

-- Composite so a payment and the share it settles belong to the same tenant,
-- and RESTRICT so a share with money attributed to it cannot be deleted out
-- from under that payment -- the same reasoning as payments_bill_same_restaurant_fk.
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_split_participant_same_restaurant_fk;
ALTER TABLE payments ADD CONSTRAINT payments_split_participant_same_restaurant_fk
  FOREIGN KEY (split_participant_id, restaurant_id)
  REFERENCES bill_split_participants (id, restaurant_id)
  ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS payments_split_participant_idx
  ON payments (split_participant_id) WHERE split_participant_id IS NOT NULL;

COMMENT ON TABLE bill_splits IS
  'A stored plan for who pays which part of a bill. Shares sum to basis_ves, the '
  'outstanding balance when the plan was agreed. Not a second source of truth for '
  'how much the bill has been paid -- that stays bills.amount_paid_ves.';
COMMENT ON COLUMN bill_split_participants.amount_paid_ves IS
  'How much of this share has settled. Advanced by the payment ledger under the '
  'not-overpaid CHECK, the per-share analogue of the bill-level ceiling.';
