# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.9.0] - 2026-04-19

### Added

- **Per-attempt audit log (`webhook_delivery_attempts`)** — 배달 시도마다 `attempt_number`, `status`, `response_status`, `response_body`(최대 4096B 절삭), `response_body_truncated`, `latency_ms`, `last_error`, `created_at`을 행으로 기록한다. `(delivery_id, attempt_number)` 유니크 제약.
- **`WebhookAdminService.getDeliveryAttempts(deliveryId)`** — 시도 이력을 `attempt_number ASC`로 조회. `WebhookDeliveryAdminService`, `WebhookDeliveryRepository` 포트에도 동일 메서드 노출.
- **`DeliveryAttemptRecord` 타입 export** — 패키지 루트에서 import 가능.
- **Endpoint snapshotting on delivery creation** — `webhook_deliveries`에 `endpoint_url_snapshot` / `signing_secret_snapshot` / `secondary_signing_secret_snapshot` 컬럼 추가. 배달 생성 시점의 URL·서명 비밀을 행에 고정 저장해, 재시도 대기 중 엔드포인트 편집이나 비밀 회전이 일어나도 이미 접수된 배달은 원래 설정대로 전송된다.
- **Secret rotation overlap** — `webhook_endpoints.previous_secret` / `previous_secret_expires_at` 컬럼 추가. 만료 전까지 신·구 비밀을 둘 다 사용해 서명하고, 수신자는 둘 중 하나만 검증해도 통과한다.
- **`WebhookSigner.signAll(eventId, timestamp, body, secrets[])`** — Standard Webhooks 스펙대로 공백 구분 다중 `v1,...` 서명 헤더를 생성. 기존 `sign()`은 `signAll([secret])`을 위임 호출.
- **`DeliveryRecord.destinationUrl`** — 배달 로그 조회 시 스냅샷된 전송 대상 URL을 노출.

### Changed

- `WebhookSigner.verify()`는 `webhook-signature` 헤더에 포함된 다수 서명 중 **하나라도 일치하면** 통과한다(timingSafeEqual 기반). 단일 서명 요청은 기존과 동일 동작.
- `PrismaDeliveryRepository`의 pending 조회가 `additionalSecrets` 배열을 함께 반환하고, `WebhookDispatcher`는 이를 `signAll`에 넘겨 다중 서명 헤더를 생성한다.

### Migration

기존 DB에는 다음 additive 스키마 변경이 필요하다:

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

기존 배달 행은 스냅샷 컬럼이 `NULL`이며, 레포지토리는 `COALESCE`로 라이브 엔드포인트 값을 폴백한다. 신규 배달부터 스냅샷이 채워진다.

비밀 회전 사용 예:

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

기존 (문자열 매칭):

```ts
onDeliveryFailed: (ctx) => {
  if (ctx.lastError?.includes('private address')) {
    alert.endpointMisconfigured(ctx);
  }
}
```

권장 (구조화 분기):

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

- **`WebhookUrlValidationError` class** — URL 검증 실패 시 plain `Error` 대신 전용 에러 클래스를 던진다. 소비자는 메시지 문자열 매칭 없이 `instanceof WebhookUrlValidationError` 로 분기할 수 있다.
- **`reason` 필드 (`WebhookUrlValidationReason`)** — 검증 실패 원인을 구조화된 값으로 노출: `'parse' | 'scheme' | 'blocked_hostname' | 'loopback' | 'private' | 'link_local' | 'invalid_target'`.
- **`url` / `resolvedIp` 필드** — 실패한 입력 URL 및 DNS 해석 결과 IP(해당되는 경우)를 에러 객체에 포함. 구조화된 400 응답(예: `{ message, reason, resolvedIp }`) 구성에 활용 가능.
- `resolveAndValidateHost(hostname, url?)` — 선택적 `url` 파라미터 추가(하위호환). 에러 객체의 `url` 필드를 채우기 위함.

### Changed

- `validateWebhookUrl` / `resolveAndValidateHost` 내부 `throw new Error(...)` 전체 치환. **메시지 포맷은 그대로 유지** — 기존 `err.message.includes('private address')` 패턴의 소비자는 영향 없음.

### Migration

기존:

```ts
} catch (err) {
  if (err instanceof Error && err.message.toLowerCase().includes('invalid webhook url')) {
    throw new BadRequestException(err.message);
  }
  throw err;
}
```

권장:

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

[0.6.1]: https://github.com/nestarc/webhook/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/nestarc/webhook/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nestarc/webhook/compare/v0.4.1...v0.5.0
[0.4.0]: https://github.com/nestarc/webhook/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nestarc/webhook/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nestarc/webhook/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nestarc/webhook/releases/tag/v0.1.0
