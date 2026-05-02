# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Webhook deliveries now treat permanent receiver `4xx` responses as terminal failures instead of retrying them through the full backoff budget. `408`, `409`, `425`, and `429` remain retryable.

### Fixed

- `WebhookDeliveryWorker` now isolates synchronous `onDeliveryFailed` callback errors as well as rejected callback promises, so notification failures cannot re-enter delivery retry handling.
- `PrismaDeliveryRepository.markFailed()` now clears `next_attempt_at` when a delivery reaches terminal `FAILED` state, keeping delivery logs from exposing stale retry schedules.

## [0.10.0] - 2026-04-30

### Added

- `WebhookEndpointAdminService.rotateSecret(endpointId, dto)` and `WebhookAdminService.rotateSecret(endpointId, dto)` now rotate endpoint signing secrets through the public admin API. The Prisma adapter moves the currently stored secret into `previous_secret`, encrypts the new secret through the configured `WebhookSecretVault`, and returns the new secret only once for receiver provisioning.

### Changed

- `DEFAULT_USER_AGENT` now includes the package version (`@nestarc/webhook/<version>`) for receiver-side debugging.
- `WebhookEndpointRepository.disableEndpoint()` now returns `true` only when the endpoint actually transitions from active to inactive. Circuit-breaker notifications use this transition result instead of the raw failure count, so a failed disable attempt can still notify on a later successful disable.
- `WebhookCircuitBreaker.afterDelivery()` now requires endpoint metadata (`tenantId`, `url`) so `onEndpointDisabled` receives a real endpoint URL instead of an empty-string fallback.

### Fixed

- Added the `WEBHOOK_SECRET_VAULT` injection token and registered/exported the configured vault provider so custom consumers can inject the active `WebhookSecretVault`.
- `onDeliveryFailed` now classifies exhausted failures without an HTTP status code as `dispatch_error` instead of `http_error`.
- Dispatch-time URL parse failures now throw `WebhookUrlValidationError` with `reason: 'parse'`, and DNS validation errors now include the original delivery URL.
- `WebhookDeliveryWorker` error logs now preserve stack traces, and shutdown waits for an active poll cycle before returning.
- Successful deliveries no longer reactivate endpoints disabled for non-circuit-breaker reasons. `resetFailures()` only clears disabled state when `disabled_reason = 'consecutive_failures_exceeded'`.
- Cooldown recovery now only reactivates endpoints disabled by the circuit breaker, preserving endpoints disabled for other reasons.

## [0.9.0] - 2026-04-19

### Added

- **Per-attempt audit log (`webhook_delivery_attempts`)** — records one row per delivery attempt with `attempt_number`, `status`, `response_status`, `response_body` (truncated at 4096 JavaScript string code units), `response_body_truncated`, `latency_ms`, `last_error`, and `created_at`. Enforces uniqueness on `(delivery_id, attempt_number)`.
- **`WebhookAdminService.getDeliveryAttempts(deliveryId)`** — returns attempt history ordered by `attempt_number ASC`. The same method is exposed through `WebhookDeliveryAdminService` and the `WebhookDeliveryRepository` port.
- **`DeliveryAttemptRecord` type export** — importable from the package root.
- **Endpoint snapshotting on delivery creation** — adds `endpoint_url_snapshot`, `signing_secret_snapshot`, and `secondary_signing_secret_snapshot` to `webhook_deliveries`. New deliveries persist the endpoint URL and signing secrets used at enqueue time, so retries continue using the original settings even if the endpoint is edited or secrets are rotated later.
- **Secret rotation overlap** — adds `webhook_endpoints.previous_secret` and `previous_secret_expires_at`. Until expiry, deliveries are signed with both current and previous secrets, and receivers may accept either signature.
- **`WebhookSigner.signAll(eventId, timestamp, body, secrets[])`** — creates space-separated multi-signature `v1,...` headers according to Standard Webhooks. The existing `sign()` method delegates to `signAll([secret])`.
- **`DeliveryRecord.destinationUrl`** — exposes the snapshotted destination URL in delivery log queries.

### Changed

- `WebhookSigner.verify()` now accepts a `webhook-signature` header when **any one** of its signatures matches, using `timingSafeEqual`. Single-signature requests keep the previous behavior.
- `PrismaDeliveryRepository` pending-delivery queries now return an `additionalSecrets` array, and `WebhookDispatcher` passes it to `signAll` to generate multi-signature headers.

### Migration

Existing databases need the following additive schema changes:

```sql
ALTER TABLE webhook_endpoints
  ADD COLUMN previous_secret TEXT,
  ADD COLUMN previous_secret_expires_at TIMESTAMPTZ;

ALTER TABLE webhook_deliveries
  ADD COLUMN endpoint_url_snapshot TEXT,
  ADD COLUMN signing_secret_snapshot TEXT,
  ADD COLUMN secondary_signing_secret_snapshot TEXT;

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
```

Existing delivery rows keep `NULL` snapshot columns. Repositories fall back to live endpoint values with `COALESCE`; snapshots are populated for new deliveries only.

Secret rotation example:

```sql
UPDATE webhook_endpoints
SET secret = :new_secret,
    previous_secret = :old_secret,
    previous_secret_expires_at = NOW() + interval '24 hours'
WHERE id = :endpoint_id;
```

## [0.8.0] - 2026-04-14

### Added

- **`failureKind` in `DeliveryFailedContext`** — high-level classification of the final failure: `'url_validation' | 'dispatch_error' | 'http_error'`. Consumers can branch without parsing `lastError` strings.
- **URL validation metadata in `DeliveryFailedContext`** — when `failureKind === 'url_validation'`, the context also carries `validationReason`, `validationUrl`, and `resolvedIp` propagated from `WebhookUrlValidationError`. Previously this structured information was lost at the worker boundary.
- **`DeliveryFailureKind` type export** — machine-readable union type re-exported from the package root.

### Changed

- `DeliveryFailedContext` gained four optional fields; existing consumers are unaffected. Hook signature unchanged.
- `WebhookDeliveryWorker` now detects `WebhookUrlValidationError` in the exception path and forwards structured metadata to `onDeliveryFailed`.

### Migration

Before (string matching):

```ts
onDeliveryFailed: (ctx) => {
  if (ctx.lastError?.includes('private address')) {
    alert.endpointMisconfigured(ctx);
  }
}
```

After (structured branching):

```ts
onDeliveryFailed: (ctx) => {
  if (ctx.failureKind === 'url_validation') {
    alert.endpointMisconfigured({
      endpointId: ctx.endpointId,
      reason: ctx.validationReason,
      resolvedIp: ctx.resolvedIp,
    });
  } else if (ctx.failureKind === 'http_error') {
    alert.downstreamUnhealthy(ctx);
  }
}
```

## [0.7.0] - 2026-04-14

### Added

- **`WebhookUrlValidationError` class** — URL validation failures now throw a dedicated error class instead of a plain `Error`. Consumers can branch with `instanceof WebhookUrlValidationError` instead of matching message strings.
- **`reason` field (`WebhookUrlValidationReason`)** — exposes the validation failure cause as a structured value: `'parse' | 'scheme' | 'blocked_hostname' | 'loopback' | 'private' | 'link_local' | 'invalid_target'`.
- **`url` / `resolvedIp` fields** — include the failed input URL and DNS-resolved IP, when applicable, on the error object. This supports structured 400 responses such as `{ message, reason, resolvedIp }`.
- `resolveAndValidateHost(hostname, url?)` — adds a backward-compatible optional `url` parameter used to populate the error object's `url` field.

### Changed

- Replaced internal `throw new Error(...)` calls in `validateWebhookUrl` / `resolveAndValidateHost`. **Message formats are unchanged**, so existing consumers using patterns such as `err.message.includes('private address')` are unaffected.

### Migration

Before:

```ts
} catch (err) {
  if (err instanceof Error && err.message.toLowerCase().includes('invalid webhook url')) {
    throw new BadRequestException(err.message);
  }
  throw err;
}
```

After:

```ts
import { WebhookUrlValidationError } from '@nestarc/webhook';

} catch (err) {
  if (err instanceof WebhookUrlValidationError) {
    throw new BadRequestException({ message: err.message, reason: err.reason });
  }
  throw err;
}
```

## [0.6.1] - 2026-04-12

### Fixed

- **`onEndpointDisabled` duplicate firing** — hook now fires only at exact threshold crossing (`===`) instead of on every failure above threshold (`>=`). Prevents duplicate alerts in multi-instance environments where concurrent failures exceed the threshold.
- **`consecutiveFailures` payload** — reports the actual failure count from `incrementFailures()` instead of the static threshold value.
- **Blocking hooks** — `onDeliveryFailed` and `onEndpointDisabled` are now truly fire-and-forget (`void Promise.resolve().catch()`). Slow callbacks no longer block delivery processing or shutdown.
- **`tenantId` type** — changed from `string` to `string | null` in both `DeliveryFailedContext` and `EndpointDisabledContext`. Consumers can now distinguish global endpoints (`null`) from tenant-scoped endpoints.
- **`package-lock.json` version** — synced to match `package.json`.

## [0.6.0] - 2026-04-12

### Added

- **`onDeliveryFailed` callback** — called when a delivery exhausts all retry attempts. Receives `DeliveryFailedContext` with delivery ID, endpoint ID, event ID, tenant ID, attempts, last error, and response status. Fire-and-forget — errors are logged, not propagated.
- **`onEndpointDisabled` callback** — called when the circuit breaker disables an endpoint. Receives `EndpointDisabledContext` with endpoint ID, tenant ID, URL, reason, and failure count. Fire-and-forget — errors are logged, not propagated.
- **`DeliveryFailedContext` type** — context object passed to the `onDeliveryFailed` callback.
- **`EndpointDisabledContext` type** — context object passed to the `onEndpointDisabled` callback.
- **`tenant_id` in `PendingDelivery`** — enrichment query now includes the endpoint's `tenant_id`, enabling tenant-aware notification hooks.

### Changed

- `WebhookCircuitBreaker.afterDelivery()` accepts an optional `meta` parameter (`{ tenantId, url }`) to pass endpoint context without extra DB queries.

## [0.5.0] - 2026-04-12

### Added

- **`polling.enabled` option** — set to `false` to disable the delivery polling loop. This allows running the webhook module in API-only mode, where a separate worker process handles delivery. Default: `true` (backward compatible).

### How to use

Run the webhook module in two separate NestJS processes sharing the same PostgreSQL database:

- **API process:** `polling: { enabled: false }` — publishes events only.
- **Worker process:** `polling: { enabled: true }` — delivers webhooks only (use `NestFactory.createApplicationContext` for HTTP-serverless operation).

Workers scale horizontally thanks to `FOR UPDATE SKIP LOCKED`. No Redis or message queue required.

## [0.4.1] - 2026-04-11

### Fixed

- **UUID tenant inserts** — INSERT queries now cast `tenant_id::uuid`, allowing `tenant_id` columns of UUID type (e.g. FK to `applications.id`).

## [0.4.0] - 2026-04-11

### Added

- **`WebhookSecretVault` port** — new port interface for encrypting/decrypting endpoint signing secrets at rest. Implement this to provide custom encryption (e.g. AES-256-GCM).
- **`PlaintextSecretVault` adapter** — default no-op vault that passes secrets through unchanged. Maintains backward compatibility when no vault is configured.
- **`secretVault` module option** — `WebhookModuleOptions` accepts an optional `secretVault` to replace the default plaintext vault.
- **`status` CHECK constraint** — `webhook_deliveries.status` column now includes a CHECK constraint limiting values to `PENDING`, `SENDING`, `SENT`, `FAILED` in the official schema.
- **`tenant_id::text` cast** — SELECT queries now cast `tenant_id::text` for comparison, enabling future UUID FK migration without breaking existing text-based tenant IDs.

### Changed

- `PrismaEndpointRepository` constructor accepts an optional `WebhookSecretVault` parameter; `createEndpoint()` encrypts the secret before storage.
- `PrismaDeliveryRepository` constructor accepts an optional `WebhookSecretVault` parameter; `enrichDeliveries()` decrypts secrets after retrieval.

## [0.3.0] - 2026-04-11

### Added

- **`sendToEndpoints(endpointIds, event)`** — send events to specific endpoint IDs instead of fan-out to all matching endpoints. Useful for SaaS platforms where API consumers specify which endpoints should receive a particular event.

## [0.2.0] - 2026-04-11

### Added

- **Ports/adapters architecture** — all services depend on port interfaces (`WebhookEventRepository`, `WebhookEndpointRepository`, `WebhookDeliveryRepository`, `WebhookHttpClient`) instead of Prisma directly. Default Prisma and fetch adapters are provided.
- **Custom adapter injection** — `WebhookModuleOptions` accepts `eventRepository`, `endpointRepository`, `deliveryRepository`, `httpClient` to replace defaults.
- **`WebhookEndpointAdminService`** — endpoint CRUD + test events (split from `WebhookAdminService`).
- **`WebhookDeliveryAdminService`** — delivery logs + manual retry (split from `WebhookAdminService`).
- **`WebhookDispatcher`** — signing + HTTP dispatch extracted from delivery worker.
- **`WebhookRetryPolicy`** — backoff calculation extracted from delivery worker.
- **Dispatch-time DNS validation** — `resolveAndValidateHost()` prevents DNS rebinding SSRF by validating resolved IPs before every POST, not only at registration.
- **IPv4-mapped IPv6 detection** — blocks `::ffff:10.0.0.1` style bypass in both literal and hex-normalized forms.
- **Async DNS resolution at registration** — hostnames like `*.nip.io` resolving to private IPs are rejected.
- **HTTP redirect blocking** — `FetchHttpClient` uses `redirect: 'manual'` to prevent SSRF via 3xx.
- **`allowPrivateUrls` option** — permits private/internal URLs for development and testing environments.
- **Stale SENDING lease recovery** — `claimed_at` column tracks when a delivery was claimed; stale recovery uses lease expiry instead of `next_attempt_at`.
- **`polling.staleSendingMinutes` option** — configures the stale delivery reaper threshold (default: 5 minutes).
- **Bounded exception retries** — dispatch/persistence exceptions increment `attempts` and apply backoff instead of blindly resetting to PENDING.
- **Post-persist state isolation** — circuit breaker failures after `markSent`/`markFailed` no longer revert delivery state.
- **`WebhookEvent` LSP guard** — throws immediately if a subclass omits `static readonly eventType`.
- **Secret exposure prevention** — `EndpointRecord` excludes `secret`; only `createEndpoint` returns `EndpointRecordWithSecret`.
- **`pgcrypto` extension** — migration SQL includes `CREATE EXTENSION IF NOT EXISTS pgcrypto` for PostgreSQL < 13.
- **CI/CD** — GitHub Actions CI (lint → test matrix → pack) and Release (verify → build → npm publish with OIDC provenance).
- **`EndpointRecordWithSecret` type** — typed internal record for contexts that need the signing secret.
- **`resolveAndValidateHost` export** — reusable DNS validation function.

### Changed

- **BREAKING:** `WebhookAdminService` is deprecated. Use `WebhookEndpointAdminService` and `WebhookDeliveryAdminService` instead. The facade remains available for 0.x compatibility and will be removed in v1.0.0.
- **BREAKING:** `EndpointRecord` no longer includes `secret`. Use `EndpointRecordWithSecret` for creation responses.
- **BREAKING:** `WebhookModuleOptions.prisma` is now optional (not needed if all custom repositories are provided).
- `WebhookDeliveryWorker` reduced from 280 lines / 7 responsibilities to a thin orchestrator.
- `WebhookCircuitBreaker` depends on `WebhookEndpointRepository` port instead of Prisma directly.
- `WebhookService` depends on three repository ports instead of raw Prisma.
- All `SELECT *` / `RETURNING *` queries replaced with explicit column aliases for correct camelCase mapping.
- `validateWebhookUrl` is now async (performs DNS resolution).

### Removed

- `resetToPending()` from `WebhookDeliveryRepository` — replaced by bounded retry accounting in catch paths.
- `SigningOptions` interface and `signing` config field — HMAC-SHA256 with Standard Webhooks headers is fixed.

### Fixed

- Endpoint records returned snake_case fields (`tenant_id`, `consecutive_failures`) instead of camelCase (`tenantId`, `consecutiveFailures`).
- Delivery log records returned snake_case fields (`event_id`, `endpoint_id`, `max_attempts`) instead of camelCase.
- Circuit breaker recovery only ran when pending deliveries existed — now runs every poll cycle.
- Poll cycles could overlap via `setInterval` — `isPolling` guard prevents concurrent execution.
- Event save and delivery creation were not atomic — wrapped in `$transaction()`.
- Exception path reset deliveries to PENDING without incrementing attempts — enabled unbounded retry loops.
- `markSent()` success followed by `afterDelivery()` failure reverted delivery to PENDING — caused duplicate sends.

## [0.1.0] - 2026-04-11

### Added

- `WebhookModule` with `forRoot()` and `forRootAsync()` registration.
- `WebhookEvent` abstract base class with `static eventType` and `toPayload()`.
- `WebhookService` with `send()` and `sendToTenant()` for event fan-out.
- `WebhookDeliveryWorker` with polling-based async delivery.
- HMAC-SHA256 signing compatible with Standard Webhooks headers.
- Exponential backoff retry (30s → 5m → 30m → 2h → 24h) with jitter.
- Circuit breaker with auto-disable and cooldown-based recovery.
- Dead letter queue (FAILED status after max retries).
- `WebhookAdminService` for endpoint CRUD, delivery logs, manual retry, test events.
- `FOR UPDATE SKIP LOCKED` for multi-instance safe delivery claiming.
- Graceful shutdown with active delivery drain.
- PostgreSQL migration SQL for 3 tables.
- Base64 secret validation (minimum 16 bytes).

[Unreleased]: https://github.com/nestarc/webhook/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/nestarc/webhook/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/nestarc/webhook/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/nestarc/webhook/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/nestarc/webhook/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/nestarc/webhook/compare/01b8e737c65e1fb39418e5b388bafa7b6459cead...v0.6.1
[0.6.0]: https://github.com/nestarc/webhook/compare/v0.5.0...01b8e737c65e1fb39418e5b388bafa7b6459cead
[0.5.0]: https://github.com/nestarc/webhook/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/nestarc/webhook/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/nestarc/webhook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nestarc/webhook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nestarc/webhook/compare/91331c91cb1463e8912ef9ed795497a2fa8e4b41...v0.2.0
[0.1.0]: https://github.com/nestarc/webhook/commit/91331c91cb1463e8912ef9ed795497a2fa8e4b41
