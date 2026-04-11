# @nestarc/webhook

Outbound webhook delivery for NestJS — HMAC signing, exponential retry, circuit breaker, delivery logs, fan-out, [Standard Webhooks](https://www.standardwebhooks.com/) compatible.

**No separate infrastructure required.** Uses your existing PostgreSQL database.

[![CI](https://github.com/nestarc/webhook/actions/workflows/ci.yml/badge.svg)](https://github.com/nestarc/webhook/actions/workflows/ci.yml)

## Features

- **Fan-out delivery** — one event to many endpoints
- **HMAC-SHA256 signing** — Standard Webhooks compatible headers
- **Exponential backoff** — 30s, 5m, 30m, 2h, 24h (with jitter)
- **Circuit breaker** — auto-disable failing endpoints, auto-recover after cooldown
- **Dead letter queue** — failed deliveries tracked for manual retry
- **Delivery logs** — full audit trail (status code, latency, response body)
- **Multi-instance safe** — `FOR UPDATE SKIP LOCKED` prevents duplicate delivery
- **Graceful shutdown** — waits for in-flight deliveries on process exit
- **SSRF defense** — DNS resolution validation at registration and dispatch time
- **Ports/adapters architecture** — swap Prisma or fetch with custom implementations
- **Stale delivery recovery** — lease-based reaper recovers crashed worker deliveries

## Installation

```bash
npm install @nestarc/webhook
```

**Peer dependencies:**

```bash
npm install @nestjs/common @nestjs/core @nestjs/schedule @prisma/client
```

## Database Setup

Run the migration SQL against your PostgreSQL database:

```bash
psql -d your_database -f node_modules/@nestarc/webhook/src/sql/create-webhook-tables.sql
```

This creates three tables: `webhook_endpoints`, `webhook_events`, `webhook_deliveries`.

The migration includes `CREATE EXTENSION IF NOT EXISTS pgcrypto` for PostgreSQL < 13 compatibility.

## Quick Start

### 1. Register the module

```typescript
import { WebhookModule } from '@nestarc/webhook';

@Module({
  imports: [
    WebhookModule.forRoot({
      prisma: prismaService,
      delivery: {
        timeout: 10_000,
        maxRetries: 5,
        backoff: 'exponential',
        jitter: true,
      },
      circuitBreaker: {
        failureThreshold: 5,
        cooldownMinutes: 60,
      },
      polling: {
        interval: 5000,
        batchSize: 50,
      },
    }),
  ],
})
export class AppModule {}
```

### 2. Define events

```typescript
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

> **Note:** Subclasses **must** define `static readonly eventType`. The module throws at runtime if this is missing.

### 3. Send events

```typescript
import { WebhookService } from '@nestarc/webhook';

@Injectable()
export class OrderService {
  constructor(private readonly webhooks: WebhookService) {}

  async createOrder(dto: CreateOrderDto) {
    const order = await this.saveOrder(dto);
    await this.webhooks.send(new OrderCreatedEvent(order.id, order.total));
    return order;
  }
}
```

### 4. Manage endpoints

```typescript
import { WebhookEndpointAdminService } from '@nestarc/webhook';

@Injectable()
export class WebhookController {
  constructor(private readonly endpointAdmin: WebhookEndpointAdminService) {}

  async register() {
    // Secret is returned only on creation
    return this.endpointAdmin.createEndpoint({
      url: 'https://customer.com/webhooks',
      events: ['order.created', 'order.paid'],
      secret: 'auto',
    });
  }
}
```

## API Reference

### WebhookService

| Method | Description |
|--------|-------------|
| `send(event)` | Publish event to all matching endpoints |
| `sendToTenant(tenantId, event)` | Publish to tenant-specific endpoints only |
| `sendToEndpoints(endpointIds, event)` | Publish to specific endpoint IDs only |

### WebhookEndpointAdminService

| Method | Description |
|--------|-------------|
| `createEndpoint(dto)` | Register a new webhook endpoint (returns secret) |
| `listEndpoints(tenantId?)` | List all endpoints (secret excluded) |
| `getEndpoint(id)` | Get endpoint details (secret excluded) |
| `updateEndpoint(id, dto)` | Update endpoint URL, events, etc. |
| `deleteEndpoint(id)` | Delete an endpoint |
| `sendTestEvent(endpointId)` | Send a `webhook.test` ping event |

### WebhookDeliveryAdminService

| Method | Description |
|--------|-------------|
| `getDeliveryLogs(endpointId, filters?)` | Query delivery history |
| `retryDelivery(deliveryId)` | Manually retry a failed delivery |

### WebhookSigner

| Method | Description |
|--------|-------------|
| `sign(eventId, timestamp, body, secret)` | Generate Standard Webhooks signature headers |
| `verify(eventId, timestamp, body, secret, signature)` | Verify a webhook signature |
| `generateSecret()` | Generate a random base64 signing secret |

> **Deprecated:** `WebhookAdminService` is a facade that delegates to `WebhookEndpointAdminService` and `WebhookDeliveryAdminService`. It will be removed in a future release.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `prisma` | — | PrismaClient instance (required unless all custom repos provided) |
| `delivery.timeout` | `10000` | HTTP request timeout (ms) |
| `delivery.maxRetries` | `5` | Maximum delivery attempts |
| `delivery.jitter` | `true` | Add random jitter to retry delays |
| `circuitBreaker.failureThreshold` | `5` | Consecutive failures before disabling endpoint |
| `circuitBreaker.cooldownMinutes` | `60` | Minutes before attempting recovery |
| `polling.interval` | `5000` | Delivery worker poll interval (ms) |
| `polling.batchSize` | `50` | Max deliveries per poll cycle |
| `polling.staleSendingMinutes` | `5` | Minutes before a stuck SENDING delivery is recovered |
| `allowPrivateUrls` | `false` | Allow private/internal URLs (dev/test only) |
| `secretVault` | `PlaintextSecretVault` | Custom vault for encrypting/decrypting endpoint secrets at rest |

### Custom adapters

Replace default Prisma or fetch implementations by providing custom ports:

```typescript
WebhookModule.forRoot({
  prisma: prismaService,
  httpClient: myCustomHttpClient,          // implements WebhookHttpClient
  eventRepository: myCustomEventRepo,      // implements WebhookEventRepository
  endpointRepository: myCustomEndpointRepo,// implements WebhookEndpointRepository
  deliveryRepository: myCustomDeliveryRepo,// implements WebhookDeliveryRepository
  secretVault: myCustomVault,              // implements WebhookSecretVault
});
```

### Async configuration

```typescript
WebhookModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: ConfigService, prisma: PrismaService) => ({
    prisma,
    delivery: {
      maxRetries: config.get('WEBHOOK_MAX_RETRIES', 5),
    },
  }),
  inject: [ConfigService, PrismaService],
});
```

## Security

### Signing

All webhooks are signed with **HMAC-SHA256** using [Standard Webhooks](https://www.standardwebhooks.com/) headers:

```
webhook-id: <event-uuid>
webhook-timestamp: <unix-seconds>
webhook-signature: v1,<base64-hmac-sha256>
```

**Secret format:** Secrets must be valid base64 strings decoding to at least 16 bytes. Use `"auto"` for automatic generation.

### SSRF defense

- Endpoint URLs are validated at **registration** and at **every dispatch**
- Blocks: private IPs, loopback, link-local, cloud metadata (169.254.x), IPv4-mapped IPv6
- DNS resolution is checked to prevent rebinding attacks
- HTTP redirects are disabled (`redirect: 'manual'`)
- Use `allowPrivateUrls: true` for local development only

### Secret handling

- Signing secrets are excluded from read queries (`listEndpoints`, `getEndpoint`)
- Secrets are only returned on `createEndpoint` (initial provisioning)
- Delivery enrichment uses an internal path that does not expose secrets through admin APIs
- **At-rest encryption** — provide a custom `WebhookSecretVault` to encrypt secrets before storage and decrypt before HMAC signing. The default `PlaintextSecretVault` passes values through unchanged.

## Webhook Payload Format

```json
{
  "type": "order.created",
  "data": {
    "orderId": "ord_123",
    "total": 99.99
  }
}
```

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌───────────────────┐
│ Your Service │────>│  WebhookService  │────>│  PostgreSQL (tx)  │
└─────────────┘     └──────────────────┘     └───────────────────┘
                            │
                    ┌───────┴────────┐
                    │ DeliveryWorker │  (polls every N seconds)
                    └───────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              v             v             v
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │Dispatcher│ │RetryPolicy│ │CircuitBkr│
        └────┬─────┘ └──────────┘ └──────────┘
             │
        ┌────┴─────┐
        │HttpClient│──> customer endpoints
        └──────────┘
```

All components depend on **port interfaces**, not concrete implementations. Default adapters use Prisma and Node.js fetch.

## License

MIT
