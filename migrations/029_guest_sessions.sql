-- Guest sessions that survive a Redis restart.
--
-- They lived only in Redis, which made a cache the sole record of who is
-- allowed to pay a bill. Restart the instance, flush the keyspace, or let
-- `maxmemory` evict under pressure, and every diner in every restaurant is
-- signed out mid-meal.
--
-- What makes that worse than the usual cache miss is that the diner cannot
-- recover on their own. The client strips the QR token out of the URL once it
-- has been exchanged (see src/routes/guest.js), so there is nothing left to mint
-- a new session with -- somebody has to get up and rescan the sticker on the
-- table, in the middle of paying.
--
-- So Postgres holds the facts and Redis keeps its job. The division is:
--
--   Postgres  who this session is, when it must die whatever happens, and
--             whether somebody ended it. Durable, and the answer after a flush.
--   Redis     the idle timer, which slides on every request. Hot, rewritten
--             constantly, and worth nothing once it is gone.
--
-- That split is what keeps this from costing a write per request. The sliding
-- TTL never touches Postgres: `expires_at` here is the *absolute* cap, set once
-- at creation and never moved. During a Redis outage the fallback therefore
-- enforces a more generous window than usual -- the cap rather than the idle
-- timeout -- which is the right way round. A diner mid-meal keeps paying; a
-- session left open in a drawer still dies on schedule.
--
-- `token_hash` and not the token, exactly as before: a dump of this table
-- yields nothing anybody can present. UNIQUE for the same reason
-- refresh_sessions is -- two rows sharing a hash would be a bug worth failing
-- on rather than a collision worth tolerating.

-- Composite key first, so the session below can carry a tenant-scoped foreign
-- key rather than trusting the restaurant_id written beside it. Same pattern as
-- migration 016.
CREATE UNIQUE INDEX IF NOT EXISTS tables_id_restaurant_idx
  ON tables (id, restaurant_id);

CREATE TABLE IF NOT EXISTS guest_sessions (
  id UUID PRIMARY KEY,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,

  -- The absolute cap, from config.guest.maxSessionAgeSeconds. Never slid.
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set when a diner ends the session. Kept rather than deleted so that a
  -- flushed Redis cannot resurrect a session somebody deliberately closed.
  revoked_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_agent TEXT,
  ip INET,

  CONSTRAINT guest_sessions_table_fk
    FOREIGN KEY (table_id, restaurant_id) REFERENCES tables (id, restaurant_id)
    ON DELETE CASCADE
);

-- The purge reads by age and nothing else.
CREATE INDEX IF NOT EXISTS guest_sessions_expires_idx
  ON guest_sessions (expires_at);

COMMENT ON TABLE guest_sessions IS
  'Durable record of a scanned-table session. Redis holds the sliding idle timer; this holds identity, the absolute expiry and revocation, so a cache flush does not sign a dining room out.';
COMMENT ON COLUMN guest_sessions.expires_at IS
  'Absolute cap, set once at creation. The idle timeout lives in Redis and never moves this.';
