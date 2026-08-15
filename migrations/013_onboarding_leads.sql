-- Registration becomes a reviewed lead rather than a self-service signup.
--
-- Migration 012 built the flow so that submitting the form emailed the
-- applicant a link and anyone holding that link created their own restaurant.
-- The business does not want that: a restaurant is qualified by a person who
-- reads the submission and telephones them. Software that hands out tenants to
-- whoever fills in a form is not faster than that process, it just skips it.
--
-- So the form now records a lead and notifies the onboarding team, and the
-- token that 012 introduced is not minted at submission time. It is minted when
-- the team invites the restaurant, after the call. The rest of 012 survives
-- unchanged and for the same reasons -- most of all that `restaurants` and
-- `users` are still only created inside the transaction that spends the token,
-- because staff email is globally unique and an unverified insert would let
-- anybody claim an address they cannot read.
--
-- Written as a follow-up rather than by editing 012 because 012 may already have
-- been applied. An edited migration that a database has recorded as run is a
-- file that no longer describes that database, and the divergence only shows up
-- as a missing column at runtime.

ALTER TABLE restaurant_signups
  -- Required by the form now. The team's next action is to telephone the
  -- restaurant, and a lead with no number cannot be worked.
  ADD COLUMN IF NOT EXISTS phone VARCHAR(40),

  -- Where the lead is in the pipeline. NEW until somebody picks it up.
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'NEW',

  ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invited_at   TIMESTAMPTZ,

  -- What the reviewer concluded. Distinct from `profile`, which is what the
  -- restaurant said about itself and is never edited after submission.
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

ALTER TABLE restaurant_signups DROP CONSTRAINT IF EXISTS restaurant_signups_status_check;
ALTER TABLE restaurant_signups ADD CONSTRAINT restaurant_signups_status_check
  CHECK (status IN ('NEW', 'CONTACTED', 'INVITED', 'ONBOARDED', 'REJECTED'));

-- A lead has no token until the team invites it, so neither column can stay
-- NOT NULL. This is the schema-level statement of the whole change: the
-- credential is issued by a decision, not by a form submission.
ALTER TABLE restaurant_signups ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE restaurant_signups ALTER COLUMN expires_at DROP NOT NULL;

-- Any lead that predates this migration was created under the old rules, which
-- means it already holds a live invitation token. Marking those INVITED keeps
-- the column honest rather than describing them as untouched leads.
UPDATE restaurant_signups SET status = 'INVITED'
 WHERE token_hash IS NOT NULL AND consumed_at IS NULL AND status = 'NEW';
UPDATE restaurant_signups SET status = 'ONBOARDED'
 WHERE consumed_at IS NOT NULL AND status = 'NEW';

-- The team's queue: oldest unworked lead first.
CREATE INDEX IF NOT EXISTS restaurant_signups_status_idx
  ON restaurant_signups (status, created_at);
