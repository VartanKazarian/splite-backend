-- Make the C2P invoice number a policy the database enforces, not a convention
-- the service happens to follow.
--
-- invoice_number is the id a payment dispute is argued over, so how it is formed
-- matters as much as that it exists. The rule (src/services/mercantilC2P.js):
--
--   SPL-<REST8>-<PAY32>
--
-- the literal "SPL", the first eight hex of the restaurant id -- so a human
-- reading a bank statement sees the tenant without a lookup -- and the payment's
-- full 32 hex, which makes the invoice globally unique and deterministic from
-- the payment alone. Server-built, never client-supplied.
--
-- The earlier form truncated the payment id to 24 hex and carried no restaurant
-- segment. This migration brings any such rows onto the policy and then locks
-- the shape in, so a malformed invoice cannot be stored even by a direct write.

-- 1. Recompute every invoice from the ids the row already holds. Deterministic
--    and idempotent: it is exactly what buildInvoiceNumber() produces, so a row
--    already in the canonical form is rewritten to itself. Doing this first is
--    what lets the CHECK below be added VALIDATED without risking a legacy row
--    failing the deploy.
UPDATE c2p_charges
   SET invoice_number =
     'SPL-'
     || upper(substr(replace(restaurant_id::text, '-', ''), 1, 8))
     || '-'
     || upper(replace(payment_id::text, '-', ''));

-- 2. Lock the shape in. A non-conforming invoice number is now impossible to
--    store, which is the auditable guarantee: every invoice in the table can be
--    read back to its restaurant and its payment, and none was supplied from
--    outside.
ALTER TABLE c2p_charges DROP CONSTRAINT IF EXISTS c2p_charges_invoice_format;
ALTER TABLE c2p_charges ADD CONSTRAINT c2p_charges_invoice_format
  CHECK (invoice_number ~ '^SPL-[0-9A-F]{8}-[0-9A-F]{32}$');

COMMENT ON COLUMN c2p_charges.invoice_number IS
  'Server-built Mercantil correlation id, SPL-<REST8>-<PAY32>. Unique, '
  'deterministic from the payment, never client-supplied. Format enforced by '
  'c2p_charges_invoice_format.';
