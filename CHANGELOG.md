# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [0.4.0] - 2026-04-11

### Added

- **`WebhookSecretVault` port** — new port interface for encrypting/decrypting endpoint signing secrets at rest. Implement this to provide custom encryption (e.g. AES-256-GCM).
- **`PlaintextSecretVault` adapter** — default no-op vault that passes secrets through unchanged. Maintains backward compatibility when no vault is configured.
- **`secretVault` module option** — `WebhookModuleOptions` accepts an optional `secretVault` to replace the default plaintext vault.
- **`status` CHECK constraint** — `webhook_deliveries.status` column now includes a CHECK constraint limiting values to `PENDING`, `SENDING`, `SENT`, `FAILED` in the official schema.
- **`tenant_id::text` cast** — SELECT queries now cast `tenant_id::text` for comparison, enabling future UUID FK migration without breaking existing text-based tenant IDs.
- **`tenant_id::uuid` cast** — INSERT queries now cast `tenant_id::uuid`, allowing `tenant_id` columns of UUID type (e.g. FK to `applications.id`).

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

- **BREAKING:** `WebhookAdminService` is deprecated. Use `WebhookEndpointAdminService` and `WebhookDeliveryAdminService` instead. The facade will be removed in v0.3.0.
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

[0.6.0]: https://github.com/nestarc/webhook/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nestarc/webhook/compare/v0.4.1...v0.5.0
[0.4.0]: https://github.com/nestarc/webhook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nestarc/webhook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nestarc/webhook/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nestarc/webhook/releases/tag/v0.1.0
