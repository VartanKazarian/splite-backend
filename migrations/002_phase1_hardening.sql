-- Phase 1 hardening: correctness constraints, audit correlation, auto-updated
-- timestamps and a globally unique staff login identity.

-- 1. Staff email must identify exactly one account.
--    Migration 001 made email unique per restaurant, which leaves login
--    ambiguous when the same address exists in two tenants. Deduplicate before
--    applying this in an environment that already has data.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
  ON users (lower(email))
  WHERE email IS NOT NULL;

-- 2. Correlate audit rows with request logs.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id VARCHAR(128);
CREATE INDEX IF NOT EXISTS audit_request_idx ON audit_logs (request_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_logs (actor_id, created_at DESC);

-- 3. A bill can never be overpaid, regardless of application-layer bugs.
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_amount_paid_within_total;
ALTER TABLE bills ADD CONSTRAINT bills_amount_paid_within_total
  CHECK (amount_paid <= total_due);

-- 4. Session housekeeping.
CREATE INDEX IF NOT EXISTS refresh_sessions_expiry_idx ON refresh_sessions (expires_at);

-- 5. updated_at maintained by the database, not by every call site.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS restaurants_set_updated_at ON restaurants;
CREATE TRIGGER restaurants_set_updated_at BEFORE UPDATE ON restaurants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS bills_set_updated_at ON bills;
CREATE TRIGGER bills_set_updated_at BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
