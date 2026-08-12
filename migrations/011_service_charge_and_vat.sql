-- Service charge and IVA on a bill.
--
-- Until now a bill total was the sum of its lines, which is not a bill any
-- Venezuelan restaurant can hand a diner: IVA is statutory and a servicio is
-- customary, and neither appeared anywhere.
--
-- The order of operations is worth stating, because a plausible-looking
-- alternative gives a different number:
--
--     subtotal            sum of the line items
--   + IVA                 a percentage of the subtotal
--   + service charge      a percentage of the subtotal, NOT taxed
--   = total
--
-- **IVA is not charged on the service charge.** Both figures are therefore
-- derived from the subtotal independently and summed; the servicio never
-- enters the taxable base. Compounding them -- taxing subtotal + service --
-- would overstate IVA on every bill, which is the mistake this comment exists
-- to prevent someone making later.
--
-- A voluntary tip is likewise untaxed, and is not modelled here at all: it is
-- chosen by the payer rather than by the restaurant, so it belongs with the
-- payment rather than with the bill.
--
-- Rates are basis points as integers: 1600 = 16.00%, 1000 = 10.00%. No float
-- ever touches a monetary value, and `services/money.js` already does the
-- arithmetic this way.

ALTER TABLE restaurants
  -- Both default to zero rather than to Venezuela's 16%, so an existing
  -- restaurant's totals cannot change underneath it when this migration runs.
  -- A new restaurant is configured deliberately.
  ADD COLUMN IF NOT EXISTS service_charge_bps INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_bps            INTEGER NOT NULL DEFAULT 0;

ALTER TABLE restaurants
  ADD CONSTRAINT restaurants_service_charge_bps_range
    CHECK (service_charge_bps >= 0 AND service_charge_bps <= 10000),
  ADD CONSTRAINT restaurants_vat_bps_range
    CHECK (vat_bps >= 0 AND vat_bps <= 10000);

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS subtotal_minor       BIGINT  NOT NULL DEFAULT 0,
  -- Snapshotted at bill creation for the same reason the FX rate is: changing
  -- a restaurant's rates must never reprice a bill that has been served.
  ADD COLUMN IF NOT EXISTS service_charge_bps   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS service_charge_minor BIGINT  NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_bps              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vat_minor            BIGINT  NOT NULL DEFAULT 0;

-- Existing bills carry a total with no breakdown behind it. Treating that
-- total as the subtotal keeps every one of them satisfying the invariant below
-- without changing a single figure.
UPDATE bills SET subtotal_minor = total_due WHERE subtotal_minor = 0 AND total_due <> 0;

ALTER TABLE bills
  ADD CONSTRAINT bills_charges_non_negative
    CHECK (subtotal_minor >= 0 AND service_charge_minor >= 0 AND vat_minor >= 0),
  ADD CONSTRAINT bills_service_charge_bps_range
    CHECK (service_charge_bps >= 0 AND service_charge_bps <= 10000),
  ADD CONSTRAINT bills_vat_bps_range
    CHECK (vat_bps >= 0 AND vat_bps <= 10000),
  -- The invariant that makes the breakdown trustworthy. A total that does not
  -- equal its parts is the drift every other derived figure here is built to
  -- avoid, and the database refuses it rather than trusting the service.
  ADD CONSTRAINT bills_total_is_sum_of_parts
    CHECK (total_due = subtotal_minor + service_charge_minor + vat_minor);

COMMENT ON COLUMN restaurants.service_charge_bps IS
  'Mandatory servicio, in basis points. 1000 = 10%. A percentage of the subtotal, and not subject to IVA.';
COMMENT ON COLUMN restaurants.vat_bps IS
  'IVA, in basis points. 1600 = 16%. Applied to the subtotal only -- never to the service charge.';
COMMENT ON COLUMN bills.service_charge_bps IS
  'The rate in force when this bill opened. Never re-read from the restaurant.';
COMMENT ON COLUMN bills.vat_bps IS
  'The rate in force when this bill opened. Never re-read from the restaurant.';
