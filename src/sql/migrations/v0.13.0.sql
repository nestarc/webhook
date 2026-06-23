-- @nestarc/webhook v0.13.0 - idempotent publish and retention metadata
-- Adds producer idempotency fields, correlation diagnostics, and payload purge metadata.

ALTER TABLE webhook_events
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS payload_purged_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_idempotency_key_idx
  ON webhook_events (COALESCE(tenant_id, ''), event_type, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
