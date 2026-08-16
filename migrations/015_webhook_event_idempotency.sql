-- Durable, event-level idempotency for provider webhooks.
--
-- What existed before this was two things, neither of which is what a provider
-- means by "you have already seen this event":
--
--   1. A Redis key on the *signature*, living for twice the timestamp
--      tolerance -- ten minutes by default. Providers re-sign every retry
--      attempt with a fresh timestamp, so the signature differs and the key
--      never matches; it only ever caught byte-identical replays. And retry
--      budgets are measured in days, not minutes.
--
--   2. The payment's own status. PENDING -> SUCCEEDED under FOR UPDATE does
--      make settlement idempotent, and it is why nothing was ever paid twice.
--      But it infers "already handled" from the state of a different object,
--      which stops being true the moment one payment has more than one event.
--
-- So: one row per processed event, written inside the same transaction that
-- settles. The two cannot come apart -- there is no ordering in which money
-- moves and the event goes unrecorded, or the reverse.

CREATE TABLE IF NOT EXISTS webhook_events_processed (
  provider          VARCHAR(40)  NOT NULL,
  provider_event_id VARCHAR(200) NOT NULL,

  -- What it resolved to. Nullable and ON DELETE SET NULL because the record
  -- that this event was handled must outlive the payment row it touched.
  payment_id  UUID REFERENCES payments(id) ON DELETE SET NULL,
  outcome     VARCHAR(32) NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- The whole mechanism. A concurrent duplicate blocks here until the first
  -- transaction commits and then fails, which is the behaviour we want: the
  -- loser rolls back having settled nothing and answers "already processed".
  PRIMARY KEY (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_processed_payment_idx
  ON webhook_events_processed (payment_id) WHERE payment_id IS NOT NULL;

COMMENT ON TABLE webhook_events_processed IS
  'One row per provider event that reached a terminal outcome. Written inside '
  'the settling transaction. Deliberately NOT written for a failed attempt: a '
  'delivery that could not be processed must stay retryable, and a claim-first '
  'design would block the retry that was supposed to fix it.';

-- Correlation only. No unique constraint here on purpose: webhook_deliveries is
-- one row per *attempt*, and the retries are exactly what somebody debugging a
-- missing payment needs to see. Uniqueness lives in the table above, which
-- counts events rather than attempts.
ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS provider_event_id VARCHAR(200);

CREATE INDEX IF NOT EXISTS webhook_deliveries_event_idx
  ON webhook_deliveries (provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
