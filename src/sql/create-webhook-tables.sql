-- @nestarc/webhook — PostgreSQL migration
-- Creates the three core tables for outbound webhook delivery.
-- Run this migration against your PostgreSQL database before using the module.

-- Required for gen_random_uuid() on PostgreSQL < 13
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  url                  VARCHAR(2048) NOT NULL,
  secret               VARCHAR(255)  NOT NULL,
  events               VARCHAR(255)[] NOT NULL DEFAULT '{}',
  active               BOOLEAN       NOT NULL DEFAULT TRUE,
  description          VARCHAR(500),
  metadata             JSONB,
  tenant_id            VARCHAR(255),

  consecutive_failures INT           NOT NULL DEFAULT 0,
  disabled_at          TIMESTAMPTZ,
  disabled_reason      VARCHAR(255),

  created_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_tenant_active
  ON webhook_endpoints (tenant_id, active);
CREATE INDEX IF NOT EXISTS idx_webhook_endpoints_active_events
  ON webhook_endpoints (active, events);

---

CREATE TABLE IF NOT EXISTS webhook_events (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  VARCHAR(255) NOT NULL,
  payload     JSONB        NOT NULL,
  tenant_id   VARCHAR(255),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_type_created
  ON webhook_events (event_type, created_at);

---

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID         NOT NULL REFERENCES webhook_events(id),
  endpoint_id     UUID         NOT NULL REFERENCES webhook_endpoints(id),
  status          VARCHAR(20)  NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempts        INT          NOT NULL DEFAULT 0,
  max_attempts    INT          NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ,
  claimed_at      TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  response_status INT,
  response_body   TEXT,
  latency_ms      INT,
  last_error      TEXT,

  CONSTRAINT fk_delivery_event    FOREIGN KEY (event_id)    REFERENCES webhook_events(id),
  CONSTRAINT fk_delivery_endpoint FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id)
);

-- Migration for existing databases:
-- ALTER TABLE webhook_deliveries
--   ADD CONSTRAINT chk_delivery_status
--   CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED'));

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status_next
  ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint_status
  ON webhook_deliveries (endpoint_id, status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event
  ON webhook_deliveries (event_id);
