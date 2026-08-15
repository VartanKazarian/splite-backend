-- Self-service restaurant registration.
--
-- Until now a new restaurant meant somebody running `npm run seed` by hand,
-- which is a person in the growth path.
--
-- The load-bearing decision here is *when the tenant comes into existence*.
-- The obvious design -- insert restaurants + users, then email a verification
-- link -- cannot be used, because migration 002 made staff email globally
-- unique:
--
--     CREATE UNIQUE INDEX users_email_unique_idx ON users (lower(email))
--
-- A public endpoint that inserts into `users` therefore lets anyone claim
-- owner@somerealrestaurant.com without ever reading that inbox, and nothing in
-- the codebase can release the address afterwards. One script against a list of
-- restaurants would permanently lock every real owner out of registering.
--
-- So an unverified signup is NOT a tenant. It waits here, in a table that
-- touches nothing else, and `restaurants` + `users` are created inside the
-- single transaction that consumes the verification token. The unique email is
-- claimed only by somebody who proved they can read the mail sent to it.
--
-- The row is kept after it is consumed rather than deleted: `profile` is what
-- the restaurant told us about itself when it signed up, and it is worth more
-- to whoever reads it later than the space it costs.

CREATE TABLE IF NOT EXISTS restaurant_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  restaurant_name VARCHAR(120) NOT NULL,

  -- Normalised to letter + 9 digits, no dashes, uppercase. Storing what the
  -- form submitted would defeat every uniqueness check below: J-12345678-9 and
  -- J123456789 are the same taxpayer and would happily coexist.
  rif VARCHAR(20) NOT NULL,

  -- Whether the RIF's check digit verified. Recorded rather than enforced: the
  -- mod-11 algorithm is applied here for the first time and has not been proven
  -- against a body of real RIFs, and turning away a legitimate restaurant at
  -- registration is a worse failure than storing one malformed tax id. Promote
  -- it to a rejection once the data says it is safe to.
  rif_checksum_ok BOOLEAN NOT NULL,

  email CITEXT NOT NULL,

  -- What the restaurant said about itself: size, current systems, free notes.
  -- JSONB rather than columns because these are qualifying questions that will
  -- be reworded by whoever owns the funnel, and a migration per question is a
  -- tax on asking better ones. Nothing operational reads it.
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Only the hash. A verification link is a bearer credential for a tenant that
  -- does not exist yet; a database dump must not be a stack of usable ones.
  -- Same construction as refresh_sessions.token_hash.
  token_hash CHAR(64) NOT NULL UNIQUE,

  expires_at TIMESTAMPTZ NOT NULL,

  -- Single use. Set in the same transaction that creates the tenant, so a
  -- replayed link cannot produce a second restaurant.
  consumed_at TIMESTAMPTZ,

  -- What this signup became, once it became something. ON DELETE SET NULL so
  -- deleting a restaurant does not delete the record of how it arrived.
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,

  ip INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Submitting the form again supersedes the pending link for that address, which
-- is also how "resend the email" works. This index serves that lookup.
CREATE INDEX IF NOT EXISTS restaurant_signups_email_pending_idx
  ON restaurant_signups (lower(email)) WHERE consumed_at IS NULL;

-- For the purge of links nobody ever clicked.
CREATE INDEX IF NOT EXISTS restaurant_signups_expiry_idx
  ON restaurant_signups (expires_at) WHERE consumed_at IS NULL;

ALTER TABLE restaurants
  -- Nullable: restaurants that predate self-service have no RIF on file, and
  -- inventing one would be worse than recording that we do not know it.
  ADD COLUMN IF NOT EXISTS rif           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS plan_tier     VARCHAR(20) NOT NULL DEFAULT 'TRIAL',
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;

ALTER TABLE restaurants DROP CONSTRAINT IF EXISTS restaurants_plan_tier_check;
ALTER TABLE restaurants ADD CONSTRAINT restaurants_plan_tier_check
  CHECK (plan_tier IN ('TRIAL', 'STARTER', 'PRO', 'ENTERPRISE'));

-- One RIF, one tenant. Without this two people at the same restaurant register
-- twice and the bills split across two tenants that can never be merged.
-- Partial, because NULL is legitimate for the rows that predate this.
CREATE UNIQUE INDEX IF NOT EXISTS restaurants_rif_unique_idx
  ON restaurants (rif) WHERE rif IS NOT NULL;
