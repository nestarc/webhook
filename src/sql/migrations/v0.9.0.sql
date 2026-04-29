-- @nestarc/webhook v0.9.0 — additive migration
-- Adds per-attempt audit logs, endpoint snapshots, and secret rotation overlap.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS previous_secret TEXT,
  ADD COLUMN IF NOT EXISTS previous_secret_expires_at TIMESTAMPTZ;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS endpoint_url_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS signing_secret_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS secondary_signing_secret_snapshot TEXT;

CREATE TABLE IF NOT EXISTS webhook_delivery_attempts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id               UUID NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempt_number            INT NOT NULL,
  status                    VARCHAR(20) NOT NULL
                            CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  response_status           INT,
  response_body             TEXT,
  response_body_truncated   BOOLEAN NOT NULL DEFAULT FALSE,
  latency_ms                INT,
  last_error                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT webhook_delivery_attempts_delivery_id_attempt_number_key
    UNIQUE (delivery_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_delivery_created
  ON webhook_delivery_attempts (delivery_id, created_at);
