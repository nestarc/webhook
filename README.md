# @nestarc/webhook

Outbound webhook delivery for NestJS — HMAC signing, exponential retry, circuit breaker, delivery logs, fan-out, [Standard Webhooks](https://www.standardwebhooks.com/) compatible.

**No separate infrastructure required.** Uses your existing PostgreSQL database.

## Features

- **Fan-out delivery** — one event to many endpoints
- **HMAC-SHA256 signing** — Standard Webhooks compatible headers
- **Exponential backoff** — 30s, 5m, 30m, 2h, 24h (with jitter)
- **Circuit breaker** — auto-disable failing endpoints, auto-recover after cooldown
- **Dead letter queue** — failed deliveries tracked for manual retry
- **Delivery logs** — full audit trail (status code, latency, response body)
- **Multi-instance safe** — `FOR UPDATE SKIP LOCKED` prevents duplicate delivery
- **Graceful shutdown** — waits for in-flight deliveries on process exit

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

## Quick Start

### 1. Register the module

```typescript
import { WebhookModule } from '@nestarc/webhook';

@Module({
  imports: [
    WebhookModule.forRoot({
      prisma: prismaService, // your PrismaClient instance
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
import { WebhookAdminService } from '@nestarc/webhook';

@Injectable()
export class WebhookController {
  constructor(private readonly admin: WebhookAdminService) {}

  async register() {
    return this.admin.createEndpoint({
      url: 'https://customer.com/webhooks',
      events: ['order.created', 'order.paid'],
      secret: 'auto', // auto-generate HMAC secret
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

### WebhookAdminService

| Method | Description |
|--------|-------------|
| `createEndpoint(dto)` | Register a new webhook endpoint |
| `listEndpoints(tenantId?)` | List all endpoints |
| `getEndpoint(id)` | Get endpoint details |
| `updateEndpoint(id, dto)` | Update endpoint URL, events, etc. |
| `deleteEndpoint(id)` | Delete an endpoint |
| `getDeliveryLogs(endpointId, filters?)` | Query delivery history |
| `retryDelivery(deliveryId)` | Manually retry a failed delivery |
| `sendTestEvent(endpointId)` | Send a `webhook.test` ping event |

### WebhookSigner

| Method | Description |
|--------|-------------|
| `sign(eventId, timestamp, body, secret)` | Generate Standard Webhooks signature headers |
| `verify(eventId, timestamp, body, secret, signature)` | Verify a webhook signature |
| `generateSecret()` | Generate a random base64 signing secret |

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `prisma` | required | PrismaClient instance |
| `delivery.timeout` | `10000` | HTTP request timeout (ms) |
| `delivery.maxRetries` | `5` | Maximum delivery attempts |
| `delivery.jitter` | `true` | Add random jitter to retry delays |
| `circuitBreaker.failureThreshold` | `5` | Consecutive failures before disabling endpoint |
| `circuitBreaker.cooldownMinutes` | `60` | Minutes before attempting recovery |
| `polling.interval` | `5000` | Delivery worker poll interval (ms) |
| `polling.batchSize` | `50` | Max deliveries per poll cycle |

Signing uses **HMAC-SHA256** with [Standard Webhooks](https://www.standardwebhooks.com/) headers (fixed, not configurable).

**Secret format:** Secrets must be valid base64 strings that decode to at least 16 bytes. Use `"auto"` to let the module generate a cryptographically secure secret.

## Async Configuration

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

**Headers (Standard Webhooks):**

```
webhook-id: <event-uuid>
webhook-timestamp: <unix-seconds>
webhook-signature: v1,<base64-hmac-sha256>
```

## License

MIT
