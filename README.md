# @nestarc/webhook — Outbound webhooks for NestJS

Send signed webhook events from a NestJS application using PostgreSQL as the delivery queue. Includes fan-out, retries, endpoint circuit breaking, and delivery history. The default adapters use Prisma and Node.js HTTP; no separate message broker is required.

[![CI](https://github.com/nestarc/webhook/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/webhook/actions/workflows/ci.yml)

[Documentation](https://nestarc.dev/packages/webhook/) · [API Reference](https://nestarc.dev/api/webhook/) · [npm](https://www.npmjs.com/package/@nestarc/webhook) · [Changelog](./CHANGELOG.md) · [Security policy](./SECURITY.md)

> **Version scope:** This README follows the current source. The install command pins `0.13.1`; changes listed under [Unreleased](./CHANGELOG.md#unreleased) require a build from this checkout until the next release. Before `1.0.0`, minor releases may contain breaking changes; review the changelog and pin exact versions.

## Contents

- [Features](#features)
- [Requirements and installation](#requirements-and-installation)
- [Database setup](#database-setup)
- [Quick start](#quick-start)
- [Publishing and delivery guarantees](#publishing-and-delivery-guarantees)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Retries, replay, and delivery history](#retries-replay-and-delivery-history)
- [Security and receiving webhooks](#security-and-receiving-webhooks)
- [Worker separation](#worker-separation)
- [Using this package with an AI agent](#using-this-package-with-an-ai-agent)

## Features

- Fan-out to subscribed endpoints, with tenant-scoped and explicitly targeted publishing.
- Producer idempotency keys that avoid creating duplicate events and delivery rows.
- HMAC-SHA256 signatures using the Standard Webhooks signing format and headers.
- Scheduled retries with jitter, failed-delivery retry, and event replay.
- Endpoint circuit breaker, recovery cooldown, and notification hooks.
- Delivery status plus per-attempt history, with retention and redaction controls.
- Queued destination and signing-secret snapshots, including rotation overlap.
- Concurrent worker claiming with `FOR UPDATE SKIP LOCKED`, stale-claim recovery, and graceful shutdown.
- URL and DNS validation against SSRF, plus configurable repository, HTTP, and secret-vault adapters.

## Requirements and installation

You need an existing NestJS application, a PostgreSQL database, and a running API process or separate delivery worker. The package supports Node.js 20+, NestJS 10 or 11, `@nestjs/schedule` 4 or 5, and Prisma Client 5, 6, or 7. Respect the stricter requirements of your selected dependencies: Prisma 7.10.0 requires Node.js `^20.19`, `^22.12`, or `>=24.0` and TypeScript 5.4+.

Install the package into your application:

```bash
npm install --save-exact @nestarc/webhook@0.13.1
```

Keep existing compatible NestJS and Prisma dependencies. For a NestJS 11 / Prisma 7 setup, the following exact versions are covered by the repository's compatibility checks:

```bash
npm install --save-exact @nestjs/common@11.2.1 @nestjs/core@11.2.1 @nestjs/schedule@5.0.1 @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0 pg@8.23.0
npm install reflect-metadata rxjs dotenv
npm install --save-dev --save-exact prisma@7.10.0 @types/pg@8.23.1
```

Prisma 5 and 6 applications can keep their existing generated client and `new PrismaClient()` construction. CI exercises NestJS 10/11 with Prisma 6, and NestJS 11 with Prisma 7, against PostgreSQL 16; support for a declared peer range does not mean every version combination is tested.

### Prisma 7 client setup

The default repositories use Prisma's raw-query and transaction APIs. Webhook tables are created by the SQL below; adding webhook models to your Prisma schema is unnecessary. The application owns the Prisma connection and must disconnect it during shutdown.

For a NestJS application compiled to CommonJS:

```prisma
// prisma/schema.prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}
```

```typescript
// prisma.config.ts
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: env('DATABASE_URL') },
});
```

Set the same connection string for Prisma, the application, and `psql`:

```bash
export DATABASE_URL='postgresql://user:password@localhost:5432/your_database'
npx prisma generate
```

Alternatively, store `DATABASE_URL` in your application's uncommitted `.env` file. The `dotenv/config` imports load it for Prisma and the application; export the variable in your shell before running the `psql` commands below.

```typescript
// src/prisma.ts
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});
```

For NestJS dependency injection and connection lifecycle management, pass your existing `PrismaService` through [async configuration](#async-configuration). A complete executable receiver and producer are in the [quick-start example](./examples/quick-start/README.md).

## Database setup

For a **new database**, run the full schema once before starting the module:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f node_modules/@nestarc/webhook/src/sql/create-webhook-tables.sql
```

This creates `webhook_endpoints`, `webhook_events`, `webhook_deliveries`, and `webhook_delivery_attempts`, including current indexes. The SQL includes `CREATE EXTENSION IF NOT EXISTS pgcrypto` for PostgreSQL versions before 13; the migration user needs permission to create the extension if it is absent.

For an **existing installation**, apply every migration newer than your installed schema, in ascending order. Re-running the full schema does not add missing columns to existing tables.

| Existing schema version | Required migration sequence |
|---|---|
| Before `0.9.0` | `v0.9.0.sql` → `v0.12.0.sql` → `v0.13.0.sql` |
| `0.9.x`–`0.11.x` | `v0.12.0.sql` → `v0.13.0.sql` |
| `0.12.x` | `v0.13.0.sql` |
| `0.13.x` | No additional migration for the changes documented here |

For example, upgrading from a schema before `0.9.0`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f node_modules/@nestarc/webhook/src/sql/migrations/v0.9.0.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f node_modules/@nestarc/webhook/src/sql/migrations/v0.12.0.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f node_modules/@nestarc/webhook/src/sql/migrations/v0.13.0.sql
```

`v0.9.0` adds attempt history, snapshots, and secret rotation; `v0.12.0` adds worker indexes; `v0.13.0` adds idempotency, correlation, and payload-purge metadata. See the [changelog](./CHANGELOG.md) before each upgrade.

## Quick start

For a complete local flow that starts a receiver, publishes an event, verifies its signature, and checks delivery status, run the [quick-start example](./examples/quick-start/README.md). The snippets below show integration into an existing NestJS application.

### 1. Register the module

```typescript
// src/app.module.ts
import { Module } from '@nestjs/common';
import { WebhookModule } from '@nestarc/webhook';
import { prisma } from './prisma';

@Module({
  imports: [WebhookModule.forRoot({ prisma })],
})
export class AppModule {}
```

Polling is enabled by default. Keep the Nest application running so queued deliveries can be processed.

### 2. Define an event

```typescript
// src/order-created.event.ts
import { WebhookEvent } from '@nestarc/webhook';

export class OrderCreatedEvent extends WebhookEvent {
  static readonly eventType = 'order.created';

  constructor(
    public readonly orderId: string,
    public readonly total: number,
  ) {
    super();
  }
}
```

Each subclass must define `static readonly eventType`; publishing throws if it is missing. Enumerable instance properties become `data` in the delivered JSON:

```json
{
  "type": "order.created",
  "data": { "orderId": "ord_123", "total": 99.99 }
}
```

### 3. Register the receiver before publishing

Inject `WebhookEndpointAdminService` into your application's endpoint-registration service and call:

```typescript
const endpoint = await endpointAdmin.createEndpoint({
  url: 'https://customer.com/webhooks', // Replace with your receiver URL.
  events: ['order.created'],          // Use ['*'] to subscribe to every event type.
  tenantId: 'tenant_123',
  secret: 'auto',                     // Omit for the same automatic generation.
});
```

Provision `endpoint.secret` to the receiver through your application's secure setup flow, then publish. Signing secrets are returned by creation and rotation; list/get APIs omit them. `tenantId` is optional and is stored as `null` when omitted.

### 4. Publish and check delivery

Register this service in the `providers` of an application module:

```typescript
import { Injectable } from '@nestjs/common';
import { WebhookDeliveryAdminService, WebhookService } from '@nestarc/webhook';
import { OrderCreatedEvent } from './order-created.event';

@Injectable()
export class OrderWebhookService {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly deliveryAdmin: WebhookDeliveryAdminService,
  ) {}

  async publish(tenantId: string, orderId: string, total: number) {
    return this.webhooks.sendToTenant(
      tenantId,
      new OrderCreatedEvent(orderId, total),
      { idempotencyKey: `order:${orderId}:created` },
    );
  }

  async deliveryHistory(endpointId: string) {
    return this.deliveryAdmin.getDeliveryLogs(endpointId);
  }
}
```

The returned string is the **event ID after the event and delivery rows commit**, not confirmation of HTTP delivery. After the worker polls, use delivery history to check `SENT`, `FAILED`, `PENDING`, or `SENDING`; match the returned event ID against `DeliveryRecord.eventId`. [Receiver verification](#signing-and-receiver-verification) uses that same ID in the `webhook-id` header.

If no active endpoints match when you publish, the event is saved with **zero deliveries**. Registering an endpoint later does not automatically deliver earlier events; use explicit replay if required.

## Publishing and delivery guarantees

The default Prisma repositories persist an event and its initial delivery rows in one transaction. That transaction is separate from your application's order/payment transaction; the public publish API does not accept an existing business transaction. If both writes must succeed atomically, design an application outbox or a custom integration around that requirement.

| Publish method | Endpoint scope |
|---|---|
| `send(event, options?)` | All active matching endpoints, **across all tenants**, including endpoints with no tenant |
| `sendToTenant(tenantId, event, options?)` | Active matching endpoints belonging to that tenant only; excludes endpoints with no tenant |
| `sendToEndpoints(ids, event, options?)` | Active matching endpoints among the IDs, across tenants |
| `sendToEndpoints(ids, event, tenantId, options?)` | Active matching endpoints among the IDs, restricted to that tenant |

An endpoint matches when its subscriptions contain the event type or `'*'`. An empty ID list saves the event without creating deliveries. These methods are application services: authenticate callers and enforce tenant authorization before invoking them.

All publish methods accept `WebhookPublishOptions`:

```typescript
await webhooks.sendToTenant('tenant_123', event, {
  idempotencyKey: 'order:ord_123:created',
  correlationId: 'request_456',
});
```

The default adapter deduplicates by tenant, event type, and idempotency key. Reusing a key returns the original event ID without updating its payload, correlation ID, or endpoint selection. Producer idempotency does not prevent duplicate HTTP requests. Correlation IDs are stored for diagnostics and are not added to the delivered payload or headers. Independent `correlationId` persistence, without an idempotency key, is an [Unreleased fix](./CHANGELOG.md#unreleased).

Delivery uses retries with a finite attempt budget. `FOR UPDATE SKIP LOCKED` prevents workers from claiming the same pending row concurrently, but it does not guarantee exactly-once delivery. If a receiver processes a request and the worker fails before saving success, the request can be sent again. A receiver must deduplicate `webhook-id` within its own processing scope and make its business side effects idempotent. Delivery can still end in `FAILED` after permanent errors or exhausted attempts, and ordering between events is not guaranteed.

## API reference

See the [full API reference](https://nestarc.dev/api/webhook/) and [consumer guide](./docs/usage.md) for type definitions, return values, errors, and operational examples. The installed package includes TypeScript declarations under `dist/`.

| Service | Methods |
|---|---|
| `WebhookService` | `send`, `sendToTenant`, `sendToEndpoints` |
| `WebhookEndpointAdminService` | `createEndpoint`, `listEndpoints`, `getEndpoint`, `updateEndpoint`, `rotateSecret`, `deleteEndpoint`, `sendTestEvent` |
| `WebhookDeliveryAdminService` | `getDeliveryLogs`, `getDeliveryAttempts`, `retryDelivery`, `retryFailedDeliveries`, `replayEvent` |
| `WebhookRetentionAdminService` | `purgeExpiredData` |
| `WebhookSigner` | `sign`, `signAll`, `verify`, `verifyWithTolerance`, `generateSecret` |

`listEndpoints()` lists all tenants; `listEndpoints(tenantId)` filters to one. Endpoint reads omit signing secrets. `sendTestEvent(endpointId)` queues a `webhook.test` event with a single attempt and returns its event ID, or `null` if the endpoint does not exist. This explicit diagnostic operation bypasses active-state and subscription matching.

`WebhookAdminService` is a deprecated facade over the endpoint and delivery admin services, deprecated since `0.2.0` and scheduled for removal in `1.0.0`.

## Configuration

| Option | Default | Description |
|---|---|---|
| `prisma` | — | Application-owned Prisma client; required unless all three custom repositories are supplied |
| `delivery.timeout` | `10000` | HTTP request timeout in milliseconds |
| `delivery.maxRetries` | `5` | **Total attempt budget, including the first request** |
| `delivery.jitter` | `true` | Add random jitter to the fixed retry schedule |
| `circuitBreaker.failureThreshold` | `5` | Consecutive failures before disabling an endpoint |
| `circuitBreaker.degradedThreshold` | — | Failure count for `onEndpointDegraded`; must be lower than `failureThreshold` |
| `circuitBreaker.cooldownMinutes` | `60` | Minutes before automatic recovery of circuit-disabled endpoints |
| `polling.enabled` | `true` | Enable delivery polling; set `false` for an API-only process |
| `polling.interval` | `5000` | Poll interval in milliseconds |
| `polling.batchSize` | `50` | Maximum rows claimed in one database claim |
| `polling.staleSendingMinutes` | `5` | Age of a `SENDING` claim before recovery |
| `polling.maxConcurrency` | `polling.batchSize` | Maximum in-flight dispatches per worker process |
| `polling.drainWhileBacklogged` | `false` | Claim more batches within a poll while backlog and capacity remain |
| `polling.maxDrainLoopsPerPoll` | `1`, or `10` with drain mode | Maximum claim loops per poll |
| `polling.drainLoopDelayMs` | `0` | Delay between drain loops in milliseconds |
| `workerObserver` | — | Best-effort poll and delivery metrics callbacks |
| `retention.eventPayloadRetentionDays` | — | Replace eligible terminal event payloads with `{}` after this many days |
| `retention.deliveryResponseBodyRetentionDays` | — | Clear eligible terminal delivery response bodies after this many days |
| `retention.attemptResponseBodyRetentionDays` | — | Clear eligible attempt response bodies after this many days |
| `redaction.sanitizePayload` | — | Transform payload before persistence **and delivery** |
| `redaction.sanitizeResponseBody` | — | Sanitize or suppress response bodies before persistence |
| `allowPrivateUrls` | `false` | Permit private/internal URLs; use only in controlled development/tests |
| `secretVault` | `PlaintextSecretVault` | Adapter for protecting signing secrets at rest |
| `eventRepository`, `endpointRepository`, `deliveryRepository` | Prisma adapters | Replace persistence ports |
| `httpClient` | `FetchHttpClient` | Replace HTTP transport; the default uses Node.js `http`/`https` |
| `onDeliveryFailed` | — | Terminal delivery failure callback |
| `onDeliveryRetryScheduled` | — | Callback after a failed attempt and its next retry time are persisted |
| `onEndpointDegraded` | — | Callback when an active endpoint reaches the configured degraded threshold |
| `onEndpointDisabled` | — | Callback when circuit breaking transitions an endpoint from active to inactive |

### Worker capacity and metrics

The default poll claims one batch and waits for its deliveries. Enable drain mode when a worker should claim additional batches within a poll:

```typescript
WebhookModule.forRoot({
  prisma,
  polling: {
    interval: 1_000,
    batchSize: 100,
    maxConcurrency: 200,
    drainWhileBacklogged: true,
    maxDrainLoopsPerPoll: 10,
  },
  workerObserver: {
    onPollComplete(result) {
      console.log({ claimed: result.claimed, sent: result.sent, durationMs: result.durationMs });
    },
    onDeliveryComplete(result) {
      console.log({ deliveryId: result.deliveryId, status: result.status });
    },
    onPollError(error) {
      console.error('Webhook worker poll failed', error);
    },
  },
});
```

Observer exceptions are logged and do not fail delivery processing. Repositories that implement optional `getBacklogSummary()` expose `pendingCount`, `sendingCount`, `runnablePendingCount`, `oldestPendingAgeMs`, and `oldestRunnableAgeMs`.

### Retention and redaction

Retention is disabled by default and has no built-in purge schedule. Call `WebhookRetentionAdminService.purgeExpiredData()` from your application's scheduler after configuring a policy:

```typescript
WebhookModule.forRoot({
  prisma,
  retention: {
    eventPayloadRetentionDays: 30,
    deliveryResponseBodyRetentionDays: 14,
    attemptResponseBodyRetentionDays: 7,
  },
  redaction: {
    sanitizePayload(payload) {
      const { email, ...remaining } = payload;
      return remaining;
    },
    sanitizeResponseBody() {
      return null;
    },
  },
});
```

Payload redaction changes what the receiver gets. Purging clears stored content; it does not delete the event/delivery metadata or idempotency key. Purged payloads cannot be replayed. The [Unreleased retry guard](./CHANGELOG.md#unreleased) also rejects manual retries of deliveries whose event payload has been purged.

### Custom adapters

```typescript
WebhookModule.forRoot({
  eventRepository: myEventRepository,       // WebhookEventRepository
  endpointRepository: myEndpointRepository, // WebhookEndpointRepository
  deliveryRepository: myDeliveryRepository,// WebhookDeliveryRepository
  httpClient: myHttpClient,                 // WebhookHttpClient
  secretVault: mySecretVault,               // WebhookSecretVault
});
```

When replacing only some repositories, also provide `prisma` for the remaining defaults. Custom repositories must share compatible transaction semantics. Optional capabilities such as idempotent persistence, bulk retry, replay, retention, and backlog reporting require the corresponding port methods; check the [consumer guide](./docs/usage.md) before replacing an adapter.

### Async configuration

Supply the module that exports your `PrismaService` in `imports` so the factory can inject it:

```typescript
WebhookModule.forRootAsync({
  imports: [ConfigModule, PrismaModule],
  useFactory: (config: ConfigService, prisma: PrismaService) => ({
    prisma,
    delivery: {
      maxRetries: Number(config.get('WEBHOOK_MAX_RETRIES') ?? 5),
    },
  }),
  inject: [ConfigService, PrismaService],
});
```

`ConfigModule`/`ConfigService` are from `@nestjs/config`; `PrismaModule`/`PrismaService` are your application's providers.

## Retries, replay, and delivery history

### Automatic retries and circuit breaking

The retry intervals are fixed at `30s`, `5m`, `30m`, `2h`, then `24h`; later retries repeat the `24h` interval. These are delays between attempts, before jitter. The default `maxRetries: 5` permits the initial request plus **four retries**, so it uses only the first four intervals. Set a total budget of at least `6` to reach the `24h` interval. The deprecated `delivery.backoff` option does not change this schedule.

| Response | Behavior |
|---|---|
| `2xx` | Mark delivery `SENT` |
| `3xx` | Retry while attempts remain; redirects are not followed |
| `408`, `409`, `425`, `429` | Retry while attempts remain |
| Other `4xx` | Mark delivery `FAILED` after the current attempt |
| `5xx` | Retry while attempts remain |
| Network, DNS, timeout, URL validation, or dispatch error | Retry while attempts remain |

Failed attempts count toward the endpoint circuit breaker. Circuit breaking stops new publications from selecting an inactive endpoint and can restore it after cooldown. **Disabling an endpoint does not cancel deliveries already queued for it**; those rows remain eligible for processing, and a successful queued delivery can reactivate a circuit-disabled endpoint before cooldown. Manually disabled endpoints are excluded from automatic breaker recovery. Do not use endpoint disablement as queue cancellation.

Notification callbacks are fire-and-forget; errors are logged and do not change persisted delivery state. `onDeliveryRetryScheduled` receives the next attempt time. `onDeliveryFailed` runs only for terminal failure, including a non-retryable response. Both carry failure details:

| `failureKind` | Meaning | Additional fields |
|---|---|---|
| `url_validation` | URL rejected by SSRF validation | `validationReason`, `validationUrl`, `resolvedIp` when available |
| `dispatch_error` | Connection, timeout, or other dispatch failure without an HTTP status; also unclassified dispatcher exceptions | — |
| `http_error` | Non-success HTTP response | `responseStatus` |

`onEndpointDegraded` fires at the exact configured failure count while the endpoint is active. `onEndpointDisabled` fires on the active-to-inactive transition. Callback `tenantId` is `null` for endpoints with no tenant.

### Manual retry, bulk retry, and replay

```typescript
const retried = await deliveryAdmin.retryDelivery(deliveryId);

const bulk = await deliveryAdmin.retryFailedDeliveries({
  endpointId,
  eventType: 'order.created',
  limit: 100,
});

const replay = await deliveryAdmin.replayEvent(eventId, {
  endpointIds: [endpointId],
  tenantId: 'tenant_123',
});
```

Manual retry requeues a failed delivery row, preserving its queued destination, secrets, and attempt count, and grants at least one additional attempt. It returns `false` if the delivery is not eligible. Bulk retry reports `matched`, `retried`, and `skipped`. With the [Unreleased retry guard](./CHANGELOG.md#unreleased), purged event payloads are ineligible for both paths.

Replay creates **new delivery rows** for the existing event ID using currently active matching endpoints and their current destination/secret snapshots. It preserves the source event's tenant scope; `tenantId` further restricts selection and cannot move an event into another tenant. A missing/purged event or an incompatible tenant filter throws; no matching endpoints returns `deliveriesCreated: 0`. Replay uses the configured `delivery.maxRetries` in the [Unreleased fix](./CHANGELOG.md#unreleased); released `0.13.1` uses five attempts.

Replay retains `webhook-id`, so a receiver that already processed that event may intentionally ignore it as a duplicate. Use a new business event if a separate processing operation is intended.

The public retry/replay options include `reason` for custom adapters. **The default Prisma adapter does not use or persist `reason`**; record support/audit notes in your application if needed.

### Delivery status and attempt history

`getDeliveryLogs()` returns each delivery's current status and latest recorded result, including the snapshotted `destinationUrl`. `getDeliveryAttempts()` returns its recorded attempt history in ascending attempt order:

```typescript
const deliveries = await deliveryAdmin.getDeliveryLogs(endpointId, { limit: 20 });
if (deliveries.length > 0) {
  const attempts = await deliveryAdmin.getDeliveryAttempts(deliveries[0].id);
}
```

The default HTTP client retains at most **4096 UTF-16 code units** of response text. Attempt records have `responseBodyTruncated` for additional repository-side truncation; that flag does not detect text already truncated by the HTTP client. Redaction or retention can further remove response content. History records persisted worker observations, not every possible network outcome: a process crash after the request but before persistence can leave no recorded receiver response for that request. Use receiver-side logs when investigating that interval.

## Security and receiving webhooks

### Signing and receiver verification

Requests use HMAC-SHA256 over `<eventId>.<unixTimestamp>.<rawBody>` and these [Standard Webhooks](https://www.standardwebhooks.com/) headers:

```text
webhook-id: <event-uuid>
webhook-timestamp: <unix-seconds>
webhook-signature: v1,<base64-hmac-sha256>
```

Compatibility here refers to the **signature format and HTTP headers**, not every part of the Standard Webhooks specification. This package uses bare base64 secrets, without a `whsec_` prefix. `generateSecret()`, omitted secrets, and case-sensitive `"auto"` generate 32 random bytes; supplied secrets retain the legacy minimum of 16 decoded bytes.

Verify the **original raw request body**, before parsing or reserializing JSON. Validate that the three headers are present as single strings, then verify signature and timestamp freshness:

```typescript
import { WebhookSigner } from '@nestarc/webhook';

const signer = new WebhookSigner();
const valid = signer.verifyWithTolerance(
  headers['webhook-id'],
  Number(headers['webhook-timestamp']),
  rawBody,
  signingSecret,
  headers['webhook-signature'],
  { toleranceSeconds: 300 },
);
```

`verify()` checks only the signature. `verifyWithTolerance()` additionally rejects timestamps too far in the past **or future**. Neither method remembers previous requests: a repeated valid request within the tolerance window still passes. After verification, atomically deduplicate `webhook-id` with the receiver's business effects or durable enqueue operation, then return a `2xx` response. See the [executable receiver](./examples/quick-start/README.md) for the full flow.

### Secrets and rotation

- `createEndpoint()` and `rotateSecret()` return the new signing secret. `listEndpoints()` and `getEndpoint()` omit it.
- The default `PlaintextSecretVault` stores secrets without encryption. Provide a `WebhookSecretVault` for encryption at rest; queue snapshots also contain signing material.
- Normal delivery rows snapshot the endpoint URL and current secret when queued. Retries keep these values after endpoint changes.
- Legacy rows created before `0.9.0` with null snapshots fall back to the endpoint's live URL/current key.

```typescript
const rotated = await endpointAdmin.rotateSecret(endpointId, {
  previousSecretExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
});

if (rotated) {
  // Securely provision rotated.secret to the receiver.
}
```

The expiry is evaluated **when a delivery row is created**. Rows created before rotation retain the old secret; rows created during the overlap snapshot both secrets and can continue using both after `previousSecretExpiresAt`; rows created after expiry use only the current secret. Expiry does not revoke keys from existing queued rows. Coordinate receiver key retirement with queued deliveries and any planned manual retries. `verify()` and `verifyWithTolerance()` accept a match against any signature in the space-separated signature header for the supplied key.

### SSRF defense

The default URL validator checks registration, URL updates, and every dispatch. It blocks private, loopback, link-local, metadata, and disallowed IPv4/IPv6 targets, resolves DNS, and the default HTTP client connects to the validated address. The default `FetchHttpClient` is implemented with Node.js `http.request`/`https.request`; it does not follow redirects. Custom HTTP clients must preserve these protections.

Set `allowPrivateUrls: true` only for controlled local development or tests, such as the executable example's loopback receiver.

URL validation failures expose structured errors:

```typescript
import { WebhookUrlValidationError } from '@nestarc/webhook';

try {
  await endpointAdmin.createEndpoint({ url, events: ['*'] });
} catch (error) {
  if (error instanceof WebhookUrlValidationError) {
    // error.reason: parse | scheme | blocked_hostname | loopback
    //             | private | link_local | invalid_target
    // error.url and, when available, error.resolvedIp identify the target.
  }
  throw error;
}
```

## Worker separation

By default, polling runs inside the NestJS application process. Run a separate worker process when delivery HTTP calls should have their own process capacity.

API process:

```typescript
WebhookModule.forRoot({ prisma, polling: { enabled: false } });
```

Worker process:

```typescript
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WebhookModule } from '@nestarc/webhook';
import { prisma } from './prisma';

@Module({
  imports: [WebhookModule.forRoot({ prisma })],
})
class WorkerModule {}

async function main() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

void main();
```

API and worker processes must share the same PostgreSQL database and compatible configuration/vault. Multiple workers coordinate pending-row claims with `FOR UPDATE SKIP LOCKED`; the [duplicate-delivery limits](#publishing-and-delivery-guarantees) still apply.

On application close, a worker waits up to 30 seconds for its active poll and in-flight deliveries. If shutdown interrupts a request, another worker can recover its stale `SENDING` row after `polling.staleSendingMinutes`. The application is responsible for invoking Nest shutdown and closing its Prisma client.

## Using this package with an AI agent

Start with the [package navigation index](./llms.txt), [consumer guide](./docs/usage.md), [executable quick start](./examples/quick-start/README.md), and installed `dist/index.d.ts`. Confirm the installed package version against the [changelog](./CHANGELOG.md) before using an API or an Unreleased fix. For hosted reference material, use the [package documentation](https://nestarc.dev/packages/webhook/), [API reference](https://nestarc.dev/api/webhook/), and site [llms.txt](https://nestarc.dev/llms.txt).

Historical design and handover documents describe earlier implementations; use the consumer guide and current public types for application code. Treat tenant scope, raw-body verification, receiver deduplication, and finite retry budgets as part of the usage contract. An agent can validate integration by running the quick-start consumer against a disposable PostgreSQL database.

## Architecture

```mermaid
flowchart LR
  A[Application service] -->|publish| B[WebhookService]
  B -->|event and delivery transaction| C[(PostgreSQL)]
  D[Delivery worker] -->|claim and record results| C
  D --> E[Dispatcher]
  D --> F[Retry policy]
  D --> G[Circuit breaker]
  E --> H[HTTP client]
  H --> I[Webhook receivers]
```

Components use port interfaces. Default persistence adapters use Prisma raw SQL; the default HTTP adapter uses Node.js `http`/`https`.

## License

MIT — see [LICENSE](./LICENSE).
