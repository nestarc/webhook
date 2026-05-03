-- @nestarc/webhook v0.12.0 - worker capacity diagnostics indexes
-- Adds partial indexes for high-volume delivery worker claim and stale recovery paths.

CREATE INDEX IF NOT EXISTS webhook_deliveries_runnable_pending_idx
  ON webhook_deliveries (next_attempt_at, id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS webhook_deliveries_sending_claimed_idx
  ON webhook_deliveries (claimed_at, id)
  WHERE status = 'SENDING';
