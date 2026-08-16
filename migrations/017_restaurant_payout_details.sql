-- Where a diner's money actually goes.
--
-- Splite never holds the money. A Pago Móvil goes from the diner's bank account
-- to the restaurant's, and the only thing the app does is know that it happened
-- and close the bill. So the payee details are not administrative trivia: they
-- are what the diner needs on screen in order to pay at all, and what any bank
-- integration will need in order to raise the charge.
--
-- Deliberately NOT in this migration: the bank API credentials. Mercantil's C2P
-- needs a merchant id, a client id, a secret key, an integrator id and a
-- terminal id, one set per restaurant, and those belong in their own table
-- encrypted at rest. Putting a secret key in a column beside the restaurant's
-- name is how a careless SELECT publishes it -- and every field below is
-- readable by design, some of them by anyone who scans a table QR. Different
-- data, opposite access rules, different tables.

ALTER TABLE restaurants
  -- The four-digit code, which is the thing everything else hangs off: it
  -- prefixes the account number, it is what Mercantil's C2P sends as
  -- destination_bank_id, and it is what decides which integration module a
  -- restaurant's payments would go through.
  ADD COLUMN IF NOT EXISTS payout_bank_code VARCHAR(4),

  -- The full 20-digit account. For transfers, and for a receipt.
  ADD COLUMN IF NOT EXISTS payout_account_number VARCHAR(20),

  -- The phone the restaurant's Pago Móvil is registered to. Distinct from any
  -- contact number: this one is an address money is sent to, and getting it
  -- wrong pays a stranger.
  ADD COLUMN IF NOT EXISTS payout_phone VARCHAR(20),

  -- The identity document the account is held under. Usually the restaurant's
  -- own RIF, but not always -- plenty of small places bank on the owner's
  -- cédula -- so it is recorded rather than assumed from restaurants.rif.
  ADD COLUMN IF NOT EXISTS payout_holder_id VARCHAR(20);

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_payout_bank_code_format;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_payout_bank_code_format
  CHECK (payout_bank_code IS NULL OR payout_bank_code ~ '^[0-9]{4}$');

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_payout_account_format;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_payout_account_format
  CHECK (payout_account_number IS NULL OR payout_account_number ~ '^[0-9]{20}$');

-- A Venezuelan account number begins with its own bank's code, so these two
-- fields are one fact typed twice and can be checked against each other. This
-- catches the common entry error -- the right account number under the wrong
-- bank in the picker -- which would otherwise only surface as a failed payment.
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_payout_account_matches_bank;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_payout_account_matches_bank
  CHECK (
    payout_account_number IS NULL
    OR payout_bank_code IS NULL
    OR left(payout_account_number, 4) = payout_bank_code
  );

-- All of it or none of it.
--
-- A half-filled payee is worse than an empty one: the screen has enough to look
-- configured and not enough to pay, and the failure lands on a diner holding a
-- phone rather than on the person who filled the form in.
ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_payout_complete;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_payout_complete
  CHECK (
    (payout_bank_code IS NULL AND payout_account_number IS NULL
       AND payout_phone IS NULL AND payout_holder_id IS NULL)
    OR
    (payout_bank_code IS NOT NULL AND payout_account_number IS NOT NULL
       AND payout_phone IS NOT NULL AND payout_holder_id IS NOT NULL)
  );

COMMENT ON COLUMN restaurants.payout_account_number IS
  'Withheld from the guest surface. Pago Móvil needs the bank, the phone and the '
  'holder id; it does not need this, and publishing it to anyone who scans a '
  'sticker is a decision rather than a side effect.';
