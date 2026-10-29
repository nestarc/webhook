# Using @nestarc/webhook

This documents the **0.13.3** contract; see the [0.13.3 changes](../CHANGELOG.md#0133---2026-10-29). Confirm the installed version before relying on the endpoint-secret provisioning fix, which is absent from `0.13.2`. For repository development, verify local changes with the [packed-source example](../examples/quick-start/README.md#verify-the-repository-build). In 0.13.1, correlation IDs are only stored with idempotency keys, replay always uses five attempts, and manual retry does not guard against purged payloads.

Start with the [README](../README.md) and the [executable example](../examples/quick-start/README.md). Online references: [usage documentation](https://nestarc.dev/packages/webhook/) and [API reference](https://nestarc.dev/api/webhook/). Use the types in your installed package when they differ from an unreleased example.

## Runtime and ownership

- The default adapters use PostgreSQL and a Prisma client supplied by the application. No Redis, broker, or separate webhook server is required.
- Supported peers: NestJS 10/11, `@nestjs/schedule` 4/5, Prisma Client 5/6/7. Match peer versions; do not bypass peer validation.
- The package declares Node >=20. Prisma 7.10.0 requires Node `^20.19 || ^22.12 || >=24.0`; use a supported version for your selected dependencies.
- Prisma 7 needs a driver adapter and a generated client. For a CommonJS Nest application, configure `moduleFormat = "cjs"` in the `prisma-client` generator. The runnable example includes generation and compilation.
- The application owns Prisma connection setup and shutdown. For signal handling, enable Nest shutdown hooks or call `app.close()` explicitly; then disconnect the application-owned database client.
- Apply SQL to the same database/schema used by the client. New installs use `src/sql/create-webhook-tables.sql` from the installed package. Existing pre-0.9 installations run v0.9.0, v0.12.0, then v0.13.0 migrations; skip migrations already applied. v0.12.0 adds performance indexes.

## First delivery

1. Prepare the database, client, and receiving HTTP endpoint.
2. Register `WebhookModule.forRoot()` or `forRootAsync()` with that client.
3. Generate a signing secret with `WebhookSigner.generateSecret()`, pass it explicitly when creating the endpoint with the intended tenant and subscriptions, then provision that original value to the receiver. This also works around the published `0.13.2` encrypting-vault response issue described below.
4. Define a `WebhookEvent` subclass with a nonempty static `eventType` and publish it.
5. Verify the raw request body and headers at the receiver, deduplicate the event, then acknowledge with `2xx`.
6. Inspect `getDeliveryLogs()` and `getDeliveryAttempts()` for the delivery result.

Publishing without any matching endpoints stores the event but creates no deliveries. Creating an endpoint later does not automatically deliver past events. Explicit replay can enqueue a retained event for current matching endpoints.

## Publish and tenant contract

| API | Destination selection with default repositories | Result |
| --- | --- | --- |
| `send(event, options?)` | Every active endpoint subscribed to the event, across all tenants, including endpoints with no tenant | `Promise<string>` event ID |
| `sendToTenant(tenantId, event, options?)` | Active subscribed endpoints whose tenant equals `tenantId`; global endpoints are excluded | `Promise<string>` event ID |
| `sendToEndpoints(ids, event, options?)` | Requested IDs, still filtered by active status and subscription, across tenants | `Promise<string>` event ID |
| `sendToEndpoints(ids, event, tenantId, options?)` | Requested IDs, also filtered to the specified tenant | `Promise<string>` event ID |

Subscriptions match an exact event name or the literal `"*"`. Patterns such as `"order.*"` are not supported. Endpoint IDs and event IDs are UUIDs with the PostgreSQL adapters. Tenant IDs are opaque strings.

`await send(...)` means the event and initial delivery rows have committed, not that HTTP delivery succeeded. The package transaction does not include an application operation such as `saveOrder()`. If both must commit atomically, integrate an application outbox/transaction strategy; do not assume two awaited calls provide that guarantee.

All publish methods accept `WebhookPublishOptions`:

- `idempotencyKey`: deduplicates by tenant, event type, and key. A duplicate returns the original event ID and creates no new delivery rows, even if the payload or targeted endpoint list changed. Reuse a key only for the same business event. This is producer-side deduplication, not receiver-side exactly-once processing.
- `correlationId`: diagnostic event metadata. In this source version it is stored independently of idempotency. It is not added to HTTP headers or the delivered payload. It does not deduplicate events. Duplicate idempotent publishes retain the original metadata.

The delivered JSON is `{ "type": "order.created", "data": { ...eventFields } }`. `sanitizePayload` receives the data object before persistence; its output is also what receivers receive.

## Delivery, retry, and concurrency

Workers atomically claim database rows using `FOR UPDATE SKIP LOCKED`. Retries, lost acknowledgements, crashes, and database write failures can produce duplicate HTTP requests. Delivery uses a bounded attempt budget; it does not guarantee eventual success or exactly-once delivery. No ordering guarantee is provided between events.

`delivery.maxRetries` means **total attempts including the first**. The default five attempts allow four retries: 30 seconds, 5 minutes, 30 minutes, and 2 hours. A sixth attempt uses the 24-hour delay; later retries reuse 24 hours. Jitter adds 0–10% to a delay, never subtracts from it. These are minimum scheduling delays; polling, backlog, and outages can delay actual dispatch.

| Result | Action |
| --- | --- |
| `2xx` | Mark `SENT` |
| `3xx`, `408`, `409`, `425`, `429`, `5xx`, network/validation/dispatch failure | Retry while attempts remain; otherwise mark `FAILED` |
| Other `4xx` | Mark `FAILED` immediately |

The fixed schedule does not interpret `Retry-After`. Redirects are not followed. The default class is named `FetchHttpClient` for compatibility but uses Node `http`/`https.request`, connecting to prevalidated IPs while preserving the original hostname for HTTP/TLS. Custom clients must honor the supplied `resolvedIpAddresses` to retain that DNS-rebinding protection.

The circuit breaker disables an endpoint for **new normal deliveries** after consecutive failures. Already queued deliveries and retries continue. A successful queued delivery may reset the breaker before cooldown; otherwise cooldown recovery can reactivate breaker-disabled endpoints. Manually disabled endpoints are not automatically reactivated by breaker recovery. Notification and observer callbacks are best-effort, not a durable notification queue.

## Signature verification and rotation

The HMAC-SHA256 input and `webhook-id`, `webhook-timestamp`, `webhook-signature` headers follow the Standard Webhooks signing format. This package accepts bare base64 secrets with at least 16 decoded bytes for compatibility and generates 32-byte secrets. It does not accept `whsec_`-prefixed secrets through endpoint management; remove the prefix only when converting a known compatible secret. Do not describe all secret formats or every Standard Webhooks recommendation as supported.

Verify the **original UTF-8 body**, not JSON that has been parsed and serialized again. Prefer `verifyWithTolerance(..., { toleranceSeconds: 300 })`; `verify()` alone performs no freshness check. Freshness permits repeated requests within the tolerance window. Store a receiver-scoped `webhook-id` deduplication key atomically with your business effect. Use durable shared storage across receiver instances. The example's in-memory set is only a single-process demonstration.

**From 0.13.3:** creation returns the original signing key, including automatically generated and explicitly supplied keys, without decrypting the stored value. Both the default Prisma repository and endpoint admin service preserve this provisioning response, matching rotation. The fix does not change storage encryption, read API redaction, tenant filtering, or queued URL/secret snapshots. Read APIs omit signing secrets; the built-in vault stores plaintext unless you supply an encryption vault.

**For 0.13.2 consumers:** `rotateSecret()` returns the original new signing key. With the default Prisma repository, `createEndpoint()` returns the stored value: plaintext with the default vault, but ciphertext with an encrypting vault. For creation on that release, generate the key before calling the service, pass it as `secret`, and provision the original value after creation succeeds, as shown in the [README quick start](../README.md#3-register-the-receiver-before-publishing). Do not provision the ciphertext or disable encryption to work around the response.

New delivery rows snapshot their URL and signing secret **when queued**. Legacy rows created before snapshot support, with null snapshot columns, fall back to the endpoint's live URL/current key. Rotation expiry controls whether a previous secret is copied as a secondary signature into a new delivery at that moment:

| When the delivery was queued | Keys retained for dispatch and retries |
| --- | --- |
| Before rotation | Its original key |
| During the overlap window | Current and previous keys |
| After the overlap window | Current key only |

Dispatch does not reevaluate expiry for existing snapshots. Rotation neither rewrites the queue nor immediately revokes a compromised key for queued deliveries. Receiver acceptance windows and operational handling of existing deliveries must account for this behavior. Replay creates fresh snapshots; manual retry preserves existing snapshots.

## Administration and retention

| Operation | Contract |
| --- | --- |
| `createEndpoint(dto)` | Returns endpoint and original provisioning secret from 0.13.3; 0.13.2 has the encrypting-vault caveat above. Invalid URL or secret throws |
| `getEndpoint(id)` / `updateEndpoint(id, dto)` | Return endpoint without secret, or `null` when missing |
| `rotateSecret(id, dto)` | Requires a future `Date`; returns endpoint and new secret, or `null` |
| `deleteEndpoint(id)` | Returns `false` when missing. The default schema prevents deletion while delivery rows reference the endpoint, raising a foreign-key error; disable it instead when retaining history |
| `sendTestEvent(id)` | Returns event ID, or `null` when missing; explicit diagnostic delivery bypasses normal subscription matching |
| `retryDelivery(id, options?)` | Requeues a failed delivery with retained payload and grants at least one additional attempt; returns `false` if ineligible/missing |
| `retryFailedDeliveries(filters, options?)` | Returns `{ matched, retried, skipped }`; limit defaults to 100, allowed range 1–1000 |
| `replayEvent(id, options?)` | Returns `{ eventId, deliveriesCreated, endpointIds }`; creates new rows for currently active matching endpoints using the configured total attempt limit |
| `purgeExpiredData(now?)` | Returns payload/response purge counts; must be invoked by the application's scheduler |

Replay reuses the original event ID. Receivers deduplicating that ID may acknowledge replay without processing it again. Coordinate intentional reprocessing with the receiver. `options.tenantId` must match the **source event's tenant**, not just the intended destination: a global event cannot be replayed with a different tenant option. `endpointIds` further restricts the destination list. Missing or payload-purged source events throw. Zero matching destinations returns zero created deliveries.

The optional retry/replay `reason` field is metadata for custom adapters. The built-in Prisma adapter does not persist it. Record support actions in your application's audit log if needed.

Retention is disabled by default. Payload purging replaces data with `{}` and marks it purged; it does not delete the event/idempotency key. This source version rejects retry and replay of purged payloads. Response retention clears response bodies only; delivery/attempt metadata remains. `sanitizeResponseBody` can suppress responses before storage.

Delivery logs show the latest persisted state of a delivery. Attempt records show recorded attempts separately. The default transport retains at most 4096 UTF-16 code units of a response body; logs are not a complete copy of every response. An interrupted process can lose the response before recording it; stale recovery records the recovery, not the lost HTTP response. The `responseBodyTruncated` flag reflects truncation by the repository and cannot detect bytes already discarded by a custom or built-in HTTP client.

## Custom adapters and authoritative references

Import public services, options, records, tokens, and ports from `@nestarc/webhook`. `WebhookDeliveryWorker`, dispatcher, retry policy, and circuit breaker exports are advanced/internal integration surfaces; normal applications use `WebhookModule` and public services.

Custom repositories must preserve transaction and tenant boundaries. Optional port capabilities include idempotent persistence, bulk retry, replay, retention, and backlog summary; calling unsupported operations throws or is unavailable. Event repositories should store the optional correlation metadata. Replay repositories receive the configured attempt budget as an optional third argument. A method with fewer parameters remains TypeScript-compatible, but must be updated to use the new metadata/budget.

For this checkout, prefer current public types and this guide over dated files in `docs/`. Historical plans explain past decisions and are not installation recipes. The [changelog](../CHANGELOG.md) identifies released versus pending behavior.
