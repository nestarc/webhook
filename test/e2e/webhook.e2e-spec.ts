import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WebhookDeliveryRepository,
} from '../../src';
import { WebhookModule } from '../../src/webhook.module';
import { WebhookService } from '../../src/webhook.service';
import { WebhookAdminService } from '../../src/webhook.admin.service';
import { WebhookDeliveryWorker } from '../../src/webhook.delivery-worker';
import { WebhookEvent } from '../../src/webhook.event';
import { WebhookSigner } from '../../src/webhook.signer';
import { WebhookEndpointAdminService } from '../../src/webhook.endpoint-admin.service';
import { PrismaDeliveryRepository } from '../../src/adapters/prisma-delivery.repository';

class TestOrderEvent extends WebhookEvent {
  static readonly eventType = 'order.created';
  constructor(public readonly orderId: string) {
    super();
  }
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://webhook_test:webhook_test@localhost:5433/webhook_test';

interface E2ePrismaTransaction {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
}

interface E2ePrismaClient extends E2ePrismaTransaction {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(
    fn: (tx: E2ePrismaTransaction) => Promise<T>,
    options?: { isolationLevel?: string; timeout?: number },
  ): Promise<T>;
}

type PrismaClientConstructor = new (options?: unknown) => E2ePrismaClient;

function createPrismaClient(): E2ePrismaClient {
  const prismaMajor = process.env.WEBHOOK_E2E_PRISMA_MAJOR ?? '7';

  if (prismaMajor === '6') {
    process.env.DATABASE_URL ??= DATABASE_URL;
    const { PrismaClient } = require('@prisma/client') as {
      PrismaClient: PrismaClientConstructor;
    };
    return new PrismaClient();
  }

  if (prismaMajor === '7') {
    const { PrismaPg } = require('@prisma/adapter-pg') as {
      PrismaPg: new (options: { connectionString: string }) => unknown;
    };
    const { PrismaClient } = require('./generated/prisma/client') as {
      PrismaClient: PrismaClientConstructor;
    };
    return new PrismaClient({
      adapter: new PrismaPg({ connectionString: DATABASE_URL }),
    });
  }

  throw new Error(`Unsupported WEBHOOK_E2E_PRISMA_MAJOR=${prismaMajor}`);
}

describe('Webhook E2E', () => {
  let module: TestingModule;
  let prisma: E2ePrismaClient;
  let webhookService: WebhookService;
  let adminService: WebhookAdminService;
  let deliveryWorker: WebhookDeliveryWorker;
  let deliveryRepo: WebhookDeliveryRepository;
  let mockServer: http.Server;
  let mockServerPort: number;
  let receivedRequests: Array<{
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;
  let serverResponseStatus: number;

  // Execute real repository SQL, then hold its transaction immediately before
  // commit. Competing operations must handle uncommitted row changes correctly.
  function holdRepositoryCommit() {
    let release!: () => void;
    let reportReady!: (pid: number) => void;
    let reportFailure!: (error: unknown) => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<number>((resolve, reject) => {
      reportReady = resolve;
      reportFailure = reject;
    });
    const repository = new PrismaDeliveryRepository({
      $transaction: async <T>(
        fn: (tx: E2ePrismaTransaction) => Promise<T>,
        options?: { isolationLevel?: string },
      ) => {
        try {
          return await prisma.$transaction(async (tx) => {
            const result = await fn(tx);
            const [state] = await tx.$queryRaw<Array<{ pid: number; isolation: string }>>`
              SELECT pg_backend_pid() AS pid,
                current_setting('transaction_isolation') AS isolation`;
            expect(state.isolation).toBe('read committed');
            reportReady(state.pid);
            await released;
            return result;
          }, { ...options, timeout: 10_000 });
        } catch (error) {
          reportFailure(error);
          throw error;
        }
      },
    });
    return { repository, ready, release };
  }

  async function expectBlockedTransaction(blockerPid: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [state] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity activity
          WHERE ${blockerPid}::int = ANY(pg_blocking_pids(activity.pid))
        ) AS blocked`;
      if (state.blocked) return;
      // Retry the observed lock condition; elapsed time alone never proves a race.
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected a PostgreSQL transaction waiting on the held event lock');
  }

  beforeAll(async () => {
    // 1. Set up Prisma
    prisma = createPrismaClient();
    await prisma.$connect();

    // 2. Run migration SQL — strip comments and execute each statement
    const sql = fs.readFileSync(
      path.join(__dirname, '../../src/sql/create-webhook-tables.sql'),
      'utf-8',
    );
    // Remove single-line comments and separator lines
    const cleaned = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    // Split by semicolons and execute each statement
    const statements = cleaned
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await prisma.$executeRawUnsafe(stmt);
    }

    // 3. Set up mock HTTP server
    receivedRequests = [];
    serverResponseStatus = 200;

    mockServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        receivedRequests.push({ headers: req.headers, body });
        res.writeHead(serverResponseStatus);
        res.end('OK');
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, () => {
        const addr = mockServer.address();
        if (addr && typeof addr !== 'string') {
          mockServerPort = addr.port;
        }
        resolve();
      });
    });

    // 4. Create NestJS test module
    module = await Test.createTestingModule({
      imports: [
        WebhookModule.forRoot({
          prisma,
          delivery: {
            timeout: 5000,
            maxRetries: 3,
            jitter: false,
          },
          circuitBreaker: {
            failureThreshold: 3,
            cooldownMinutes: 1,
          },
          polling: {
            enabled: false, // Tests call poll manually, including with different vaults.
            batchSize: 10,
          },
          allowPrivateUrls: true, // E2E tests use localhost
        }),
      ],
    }).compile();

    webhookService = module.get(WebhookService);
    adminService = module.get(WebhookAdminService);
    deliveryWorker = module.get(WebhookDeliveryWorker);
    deliveryRepo = module.get(WEBHOOK_DELIVERY_REPOSITORY);

    await module.init();
  });

  afterAll(async () => {
    await module?.close();
    mockServer?.close();

    // Clean up tables
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS webhook_deliveries CASCADE');
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS webhook_events CASCADE');
    await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS webhook_endpoints CASCADE');
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean data between tests
    await prisma.$executeRawUnsafe('DELETE FROM webhook_delivery_attempts');
    await prisma.$executeRawUnsafe('DELETE FROM webhook_deliveries');
    await prisma.$executeRawUnsafe('DELETE FROM webhook_events');
    await prisma.$executeRawUnsafe('DELETE FROM webhook_endpoints');
    receivedRequests = [];
    serverResponseStatus = 200;
  });

  it('should deliver a webhook to a registered endpoint', async () => {
    // Register endpoint
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    // Send event
    const eventId = await webhookService.send(new TestOrderEvent('ord_1'));

    // Manually trigger delivery
    await deliveryWorker.poll();

    // Verify
    expect(receivedRequests).toHaveLength(1);
    const req = receivedRequests[0];
    expect(req.headers['webhook-id']).toBe(eventId);
    expect(req.headers['webhook-signature']).toMatch(/^v1,.+$/);
    expect(req.headers['content-type']).toBe('application/json');

    const body = JSON.parse(req.body);
    expect(body.type).toBe('order.created');
    expect(body.data.orderId).toBe('ord_1');

    // Check delivery status in DB
    const logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('SENT');
    expect(logs[0].destinationUrl).toBe(`http://localhost:${mockServerPort}/webhook`);
    expect(logs[0].tenantId).toBeNull();

    // Verify camelCase shape on EndpointRecord
    expect(endpoint.tenantId).toBeNull(); // null, not undefined
    expect(endpoint.consecutiveFailures).toBe(0);
    expect(endpoint.previousSecretExpiresAt).toBeNull();
    expect(endpoint.createdAt).toBeInstanceOf(Date);
    expect(endpoint.updatedAt).toBeInstanceOf(Date);
    expect(endpoint).not.toHaveProperty('tenant_id');
    expect(endpoint).not.toHaveProperty('consecutive_failures');

    // Verify camelCase shape on DeliveryRecord
    const log = logs[0];
    expect(log.eventId).toBeDefined();
    expect(log.endpointId).toBe(endpoint.id);
    expect(log.maxAttempts).toBe(3);
    expect(log.latencyMs).toBeGreaterThanOrEqual(0);
    expect(log.completedAt).toBeInstanceOf(Date);
    expect(log).not.toHaveProperty('event_id');
    expect(log).not.toHaveProperty('endpoint_id');
    expect(log).not.toHaveProperty('max_attempts');

    const attempts = await adminService.getDeliveryAttempts(log.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe('SENT');
  });

  it('should not update a healthy endpoint row after a successful delivery', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    const beforeRows = await prisma.$queryRaw<
      Array<{ updated_at: Date; consecutive_failures: number; disabled_reason: string | null }>
    >`
      SELECT updated_at, consecutive_failures, disabled_reason
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;
    expect(beforeRows).toHaveLength(1);
    expect(beforeRows[0].consecutive_failures).toBe(0);
    expect(beforeRows[0].disabled_reason).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 25));

    await webhookService.send(new TestOrderEvent('ord_success_noop_reset'));
    await deliveryWorker.poll();

    const afterRows = await prisma.$queryRaw<
      Array<{ updated_at: Date; consecutive_failures: number; disabled_reason: string | null }>
    >`
      SELECT updated_at, consecutive_failures, disabled_reason
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;

    expect(receivedRequests).toHaveLength(1);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].consecutive_failures).toBe(0);
    expect(afterRows[0].disabled_reason).toBeNull();
    expect(afterRows[0].updated_at.getTime()).toBe(beforeRows[0].updated_at.getTime());
  });

  it('should clear accumulated endpoint failures after a successful delivery', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await prisma.$executeRaw`
      UPDATE webhook_endpoints
      SET consecutive_failures = 2,
          updated_at = NOW() - INTERVAL '1 minute'
      WHERE id = ${endpoint.id}::uuid
    `;

    const beforeRows = await prisma.$queryRaw<Array<{ consecutive_failures: number }>>`
      SELECT consecutive_failures
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;
    expect(beforeRows[0].consecutive_failures).toBe(2);

    await webhookService.send(new TestOrderEvent('ord_success_resets_failures'));
    await deliveryWorker.poll();

    const afterRows = await prisma.$queryRaw<
      Array<{
        active: boolean;
        consecutive_failures: number;
        disabled_at: Date | null;
        disabled_reason: string | null;
      }>
    >`
      SELECT active, consecutive_failures, disabled_at, disabled_reason
      FROM webhook_endpoints
      WHERE id = ${endpoint.id}::uuid
    `;

    expect(receivedRequests).toHaveLength(1);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].active).toBe(true);
    expect(afterRows[0].consecutive_failures).toBe(0);
    expect(afterRows[0].disabled_at).toBeNull();
    expect(afterRows[0].disabled_reason).toBeNull();
  });

  it('should not deliver to endpoints not subscribed to the event', async () => {
    await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.paid'], // different event
    });

    await webhookService.send(new TestOrderEvent('ord_2'));
    await deliveryWorker.poll();

    expect(receivedRequests).toHaveLength(0);
  });

  it('should deliver to wildcard (*) endpoints', async () => {
    await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['*'],
    });

    await webhookService.send(new TestOrderEvent('ord_3'));
    await deliveryWorker.poll();

    expect(receivedRequests).toHaveLength(1);
  });

  it('should retry on failure and eventually succeed', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await webhookService.send(new TestOrderEvent('ord_4'));

    // First attempt: fail
    serverResponseStatus = 500;
    await deliveryWorker.poll();
    expect(receivedRequests).toHaveLength(1);

    let logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs[0].status).toBe('PENDING'); // scheduled for retry

    // Manually set next_attempt_at to now so we can poll again immediately
    await prisma.$executeRawUnsafe(
      `UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE endpoint_id = '${endpoint.id}'::uuid`,
    );

    // Second attempt: succeed
    serverResponseStatus = 200;
    receivedRequests = [];
    await deliveryWorker.poll();

    logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs[0].status).toBe('SENT');
    expect(logs[0].attempts).toBe(2);
  });

  it('should fail permanent client errors without scheduling retry', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await webhookService.send(new TestOrderEvent('ord_4_perm'));

    serverResponseStatus = 410;
    await deliveryWorker.poll();

    expect(receivedRequests).toHaveLength(1);

    const logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('FAILED');
    expect(logs[0].attempts).toBe(1);
    expect(logs[0].maxAttempts).toBe(3);
    expect(logs[0].responseStatus).toBe(410);
    expect(logs[0].nextAttemptAt).toBeNull();
    expect(logs[0].completedAt).toBeInstanceOf(Date);

    const attempts = await adminService.getDeliveryAttempts(logs[0].id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[0].responseStatus).toBe(410);
  });

  it('should mark as FAILED after max retries exhausted', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await webhookService.send(new TestOrderEvent('ord_5'));
    serverResponseStatus = 500;

    // Exhaust all 3 retries
    for (let i = 0; i < 3; i++) {
      await deliveryWorker.poll();
      // Reset next_attempt_at for next poll
      await prisma.$executeRawUnsafe(
        `UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE status = 'PENDING' AND endpoint_id = '${endpoint.id}'::uuid`,
      );
    }

    const logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs[0].status).toBe('FAILED');
  });

  it('should disable endpoint after consecutive failures (circuit breaker)', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    serverResponseStatus = 500;

    // Send 3 events (threshold=3) and have them all fail their first attempt
    for (let i = 0; i < 3; i++) {
      await webhookService.send(new TestOrderEvent(`ord_cb_${i}`));
    }

    // Process all deliveries at once — each fails, incrementing the counter
    await deliveryWorker.poll();

    // Exhaust retries to trigger all circuit breaker increments
    for (let attempt = 0; attempt < 3; attempt++) {
      await prisma.$executeRawUnsafe(
        `UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE status = 'PENDING'`,
      );
      await deliveryWorker.poll();
    }

    // Check endpoint status
    const ep = await adminService.getEndpoint(endpoint.id);
    expect(ep!.active).toBe(false);
  });

  it('reports delivery backlog summary counts and runnable ages', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    for (let i = 0; i < 3; i++) {
      await webhookService.send(new TestOrderEvent(`ord_backlog_${i}`));
    }

    const deliveries = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id
      FROM webhook_deliveries
      WHERE endpoint_id = ${endpoint.id}::uuid
      ORDER BY id ASC`;
    expect(deliveries).toHaveLength(3);

    await prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET next_attempt_at = NOW() + INTERVAL '10 minutes'
      WHERE id = ${deliveries[0].id}::uuid`;
    await prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'SENDING', claimed_at = NOW()
      WHERE id = ${deliveries[1].id}::uuid`;

    const summary = await deliveryRepo.getBacklogSummary!();

    expect(summary.pendingCount).toBe(2);
    expect(summary.sendingCount).toBe(1);
    expect(summary.runnablePendingCount).toBe(1);
    expect(typeof summary.oldestPendingAgeMs).toBe('number');
    expect(typeof summary.oldestRunnableAgeMs).toBe('number');
  });

  it('should support manual retry of failed deliveries', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    await webhookService.send(new TestOrderEvent('ord_retry'));
    serverResponseStatus = 500;

    // Exhaust retries
    for (let i = 0; i < 3; i++) {
      await deliveryWorker.poll();
      await prisma.$executeRawUnsafe(
        `UPDATE webhook_deliveries SET next_attempt_at = NOW() WHERE status = 'PENDING' AND endpoint_id = '${endpoint.id}'::uuid`,
      );
    }

    let logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs[0].status).toBe('FAILED');

    // Manual retry
    serverResponseStatus = 200;
    const retried = await adminService.retryDelivery(logs[0].id);
    expect(retried).toBe(true);

    await deliveryWorker.poll();

    logs = await adminService.getDeliveryLogs(endpoint.id);
    expect(logs[0].status).toBe('SENT');
  });

  it('should deduplicate idempotent tenant publishes with non-UUID tenant IDs', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
      tenantId: 'tenant_123',
    });

    const firstEventId = await webhookService.sendToTenant(
      'tenant_123',
      new TestOrderEvent('ord_idempotent'),
      { idempotencyKey: 'order:ord_idempotent:created' },
    );
    const secondEventId = await webhookService.sendToTenant(
      'tenant_123',
      new TestOrderEvent('ord_idempotent'),
      { idempotencyKey: 'order:ord_idempotent:created' },
    );

    expect(secondEventId).toBe(firstEventId);

    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM webhook_deliveries
      WHERE endpoint_id = ${endpoint.id}::uuid`;
    expect(Number(rows[0].count)).toBe(1);
  });

  it.each(['send', 'sendToTenant', 'sendToEndpoints'] as const)(
    'should persist correlationId without idempotencyKey through %s',
    async (method) => {
      const endpoint = await adminService.createEndpoint({
        url: `http://localhost:${mockServerPort}/webhook`,
        events: ['order.created'],
        tenantId: 'correlation-tenant',
      });
      const options = { correlationId: 'shared-trace-without-idempotency' };
      const publish = () => {
        const event = new TestOrderEvent('ord_correlation_only');
        if (method === 'sendToTenant') {
          return webhookService.sendToTenant('correlation-tenant', event, options);
        }
        if (method === 'sendToEndpoints') {
          return webhookService.sendToEndpoints([endpoint.id], event, options);
        }
        return webhookService.send(event, options);
      };

      const firstId = await publish();
      const secondId = await publish();
      expect(secondId).not.toBe(firstId);
      const rows = await prisma.$queryRaw<Array<{
        correlation_id: string | null;
        idempotency_key: string | null;
      }>>`
        SELECT correlation_id, idempotency_key FROM webhook_events
        WHERE id IN (${firstId}::uuid, ${secondId}::uuid)`;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row).toEqual({
          correlation_id: options.correlationId,
          idempotency_key: null,
        });
      }
      await deliveryWorker.poll();
      expect(receivedRequests).toHaveLength(2);
    },
  );

  it('should support bulk retry of failed deliveries', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    serverResponseStatus = 410;
    await webhookService.send(new TestOrderEvent('ord_bulk_retry_1'));
    await webhookService.send(new TestOrderEvent('ord_bulk_retry_2'));
    await deliveryWorker.poll();

    const result = await adminService.retryFailedDeliveries({
      endpointId: endpoint.id,
      eventType: 'order.created',
      limit: 10,
    });

    expect(result).toEqual({ matched: 2, retried: 2, skipped: 0 });

    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM webhook_deliveries
      WHERE endpoint_id = ${endpoint.id}::uuid
        AND status = 'PENDING'`;
    expect(Number(rows[0].count)).toBe(2);
  });

  it('should skip purged payloads in manual and bulk retry while retrying retained payloads', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });
    const expiredEventId = await webhookService.send(new TestOrderEvent('ord_expired'));
    const retainedEventId = await webhookService.send(new TestOrderEvent('ord_retained'));
    serverResponseStatus = 400;
    await deliveryWorker.poll();
    await prisma.$executeRaw`
      UPDATE webhook_events SET created_at = NOW() - INTERVAL '30 days'
      WHERE id = ${expiredEventId}::uuid`;
    expect(await deliveryRepo.purgeExpiredData!({ eventPayloadRetentionDays: 7 }))
      .toMatchObject({ eventsPurged: 1 });

    const logs = await adminService.getDeliveryLogs(endpoint.id);
    const expiredDelivery = logs.find((log) => log.eventId === expiredEventId)!;
    expect(await adminService.retryDelivery(expiredDelivery.id)).toBe(false);
    expect(await adminService.retryFailedDeliveries({ endpointId: endpoint.id }))
      .toEqual({ matched: 2, retried: 1, skipped: 1 });

    const rows = await prisma.$queryRaw<Array<{ event_id: string; status: string }>>`
      SELECT event_id, status FROM webhook_deliveries
      WHERE endpoint_id = ${endpoint.id}::uuid`;
    expect(rows).toEqual(expect.arrayContaining([
      { event_id: expiredEventId, status: 'FAILED' },
      { event_id: retainedEventId, status: 'PENDING' },
    ]));
    receivedRequests = [];
    serverResponseStatus = 200;
    await deliveryWorker.poll();
    expect(receivedRequests).toHaveLength(1);
    expect(JSON.parse(receivedRequests[0].body).data.orderId).toBe('ord_retained');
  });

  it('should replay an event to active matching endpoints', async () => {
    await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    const eventId = await webhookService.send(new TestOrderEvent('ord_replay'));
    await deliveryWorker.poll();
    expect(receivedRequests).toHaveLength(1);

    const result = await adminService.replayEvent(eventId, {
      reason: 'e2e replay',
    });

    expect(result.eventId).toBe(eventId);
    expect(result.deliveriesCreated).toBe(1);
    expect(result.endpointIds).toHaveLength(1);

    const replayed = await prisma.$queryRaw<Array<{ max_attempts: number }>>`
      SELECT max_attempts FROM webhook_deliveries
      WHERE event_id = ${eventId}::uuid AND status = 'PENDING'`;
    expect(replayed).toEqual([{ max_attempts: 3 }]);

    await deliveryWorker.poll();
    expect(receivedRequests).toHaveLength(2);
  });

  it('should not create targeted deliveries for endpoints outside the event tenant', async () => {
    await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/tenant-a`,
      events: ['order.created'],
      tenantId: 'tenant-a',
    });
    const otherTenantEndpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/tenant-b`,
      events: ['order.created'],
      tenantId: 'tenant-b',
    });

    const eventId = await webhookService.sendToEndpoints(
      [otherTenantEndpoint.id],
      new TestOrderEvent('ord_target_tenant_guard'),
      'tenant-a',
    );

    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM webhook_deliveries
      WHERE event_id = ${eventId}::uuid`;
    expect(Number(rows[0].count)).toBe(0);
  });

  it('should bind replay source events to their original tenant', async () => {
    const sourceTenantEndpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/tenant-a`,
      events: ['order.created'],
      tenantId: 'tenant-a',
    });
    const otherTenantEndpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/tenant-b`,
      events: ['order.created'],
      tenantId: 'tenant-b',
    });

    const eventId = await webhookService.sendToTenant(
      'tenant-a',
      new TestOrderEvent('ord_replay_tenant_guard'),
    );

    const result = await adminService.replayEvent(eventId, {
      endpointIds: [sourceTenantEndpoint.id, otherTenantEndpoint.id],
      reason: 'tenant boundary replay check',
    });

    expect(result.deliveriesCreated).toBe(1);
    expect(result.endpointIds).toEqual([sourceTenantEndpoint.id]);

    await expect(
      adminService.replayEvent(eventId, {
        tenantId: 'tenant-b',
        endpointIds: [otherTenantEndpoint.id],
        reason: 'cross-tenant replay check',
      }),
    ).rejects.toThrow('Webhook event is missing or its payload has been purged');
  });

  it('should purge expired webhook payload and response body data', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    const eventId = await webhookService.send(new TestOrderEvent('ord_purge'));
    await deliveryWorker.poll();

    const purgeResult = await deliveryRepo.purgeExpiredData!(
      {
        eventPayloadRetentionDays: 0,
        deliveryResponseBodyRetentionDays: 0,
        attemptResponseBodyRetentionDays: 0,
      },
      new Date(Date.now() + 1000),
    );

    expect(purgeResult.eventsPurged).toBe(1);
    expect(purgeResult.deliveriesPurged).toBe(1);
    expect(purgeResult.attemptsPurged).toBe(1);

    const rows = await prisma.$queryRaw<
      Array<{
        payload: unknown;
        payload_purged_at: Date | null;
        response_body: string | null;
      }>
    >`
      SELECT ev.payload, ev.payload_purged_at, d.response_body
      FROM webhook_events ev
      JOIN webhook_deliveries d ON d.event_id = ev.id
      WHERE ev.id = ${eventId}::uuid
        AND d.endpoint_id = ${endpoint.id}::uuid`;

    expect(rows[0].payload).toEqual({});
    expect(rows[0].payload_purged_at).toBeInstanceOf(Date);
    expect(rows[0].response_body).toBeNull();
  });

  describe('retention concurrency', () => {
    type RequeueOperation = 'retry' | 'bulk retry' | 'replay';
    const operations: RequeueOperation[] = ['retry', 'bulk retry', 'replay'];

    async function failedDelivery() {
      const endpoint = await adminService.createEndpoint({
        url: `http://localhost:${mockServerPort}/webhook`,
        events: ['order.created'],
      });
      const eventId = await webhookService.send(new TestOrderEvent('ord_retention_race'));
      serverResponseStatus = 400;
      await deliveryWorker.poll();
      const [delivery] = await adminService.getDeliveryLogs(endpoint.id);
      expect(delivery.status).toBe('FAILED');
      return { eventId, endpointId: endpoint.id, deliveryId: delivery.id };
    }

    function requeue(
      repository: WebhookDeliveryRepository,
      operation: RequeueOperation,
      fixture: Awaited<ReturnType<typeof failedDelivery>>,
    ): Promise<unknown> {
      if (operation === 'retry') return repository.retryDelivery(fixture.deliveryId);
      if (operation === 'bulk retry') {
        return repository.retryFailedDeliveries!({ endpointId: fixture.endpointId });
      }
      return repository.replayEvent!(fixture.eventId, undefined, 3);
    }

    it.each(operations)('should not queue a purged payload when retention wins against %s', async (operation) => {
      const fixture = await failedDelivery();
      const held = holdRepositoryCommit();
      const purging = held.repository.purgeExpiredData(
        { eventPayloadRetentionDays: 0 }, new Date(Date.now() + 1000),
      );
      // Attach rejection handling before another transaction is allowed to wait.
      const purgeResult = purging.then((value) => ({ value }), (error: unknown) => ({ error }));
      let competing!: Promise<{ value: unknown; error?: never } | { error: unknown; value?: never }>;
      try {
        const pid = await held.ready;
        competing = requeue(deliveryRepo, operation, fixture)
          .then((value) => ({ value }), (error: unknown) => ({ error }));
        if (operation === 'bulk retry') {
          // Bulk retry skips the event lock instead of waiting for retention.
          expect(await competing).toEqual({ value: { matched: 0, retried: 0, skipped: 0 } });
        } else {
          await expectBlockedTransaction(pid);
        }
      } finally {
        held.release();
        expect(await purgeResult).toMatchObject({ value: { eventsPurged: 1 } });
      }

      const result = await competing;
      if (operation === 'retry') expect(result).toEqual({ value: false });
      if (operation === 'replay') {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message)
          .toBe('Webhook event is missing or its payload has been purged');
      }
      const [state] = await prisma.$queryRaw<Array<{
        payload_purged_at: Date | null; queued: bigint;
      }>>`
        SELECT ev.payload_purged_at,
          (SELECT COUNT(*) FROM webhook_deliveries d
           WHERE d.event_id = ev.id AND d.status IN ('PENDING', 'SENDING')) AS queued
        FROM webhook_events ev WHERE ev.id = ${fixture.eventId}::uuid`;
      expect(state.payload_purged_at).toBeInstanceOf(Date);
      expect(Number(state.queued)).toBe(0);
    });

    it.each(operations)('should retain the payload when %s wins against retention', async (operation) => {
      const fixture = await failedDelivery();
      const held = holdRepositoryCommit();
      const requeueResult = requeue(held.repository, operation, fixture)
        .then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await held.ready;
        // Retention observes the old FAILED row but must skip its locked event.
        expect(await deliveryRepo.purgeExpiredData!(
          { eventPayloadRetentionDays: 0 }, new Date(Date.now() + 1000),
        )).toMatchObject({ eventsPurged: 0 });
      } finally {
        held.release();
        expect(await requeueResult).not.toHaveProperty('error');
      }
      // After commit, the queued delivery also protects its retained event.
      expect(await deliveryRepo.purgeExpiredData!(
        { eventPayloadRetentionDays: 0 }, new Date(Date.now() + 1000),
      )).toMatchObject({ eventsPurged: 0 });
      const [event] = await prisma.$queryRaw<Array<{
        payload: { orderId: string }; payload_purged_at: Date | null;
      }>>`
        SELECT payload, payload_purged_at FROM webhook_events
        WHERE id = ${fixture.eventId}::uuid`;
      expect(event.payload_purged_at).toBeNull();
      expect(event.payload.orderId).toBe('ord_retention_race');

      receivedRequests = [];
      serverResponseStatus = 200;
      await deliveryWorker.poll();
      expect(receivedRequests).toHaveLength(1);
      expect(JSON.parse(receivedRequests[0].body).data.orderId).toBe('ord_retention_race');
    });
  });

  it('should send test event to endpoint', async () => {
    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
    });

    const testEventId = await adminService.sendTestEvent(endpoint.id);
    expect(testEventId).toBeTruthy();

    await deliveryWorker.poll();

    expect(receivedRequests).toHaveLength(1);
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.type).toBe('webhook.test');
  });

  it('should send multi-signature headers during secret rotation overlap', async () => {
    const oldSecret = Buffer.from('old-secret-for-overlap').toString('base64');
    const newSecret = Buffer.from('new-secret-for-overlap').toString('base64');
    const signer = new WebhookSigner();

    const endpoint = await adminService.createEndpoint({
      url: `http://localhost:${mockServerPort}/webhook`,
      events: ['order.created'],
      secret: oldSecret,
    });

    const rotated = await adminService.rotateSecret(endpoint.id, {
      secret: newSecret,
      previousSecretExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(rotated!.secret).toBe(newSecret);

    const eventId = await webhookService.send(new TestOrderEvent('ord_overlap'));
    await deliveryWorker.poll();

    expect(receivedRequests).toHaveLength(1);
    const req = receivedRequests[0];
    const signatureHeader = req.headers['webhook-signature'] as string;
    const timestamp = Number(req.headers['webhook-timestamp']);

    expect(signatureHeader.split(' ')).toHaveLength(2);
    expect(
      signer.verify(eventId, timestamp, req.body, newSecret, signatureHeader),
    ).toBe(true);
    expect(
      signer.verify(eventId, timestamp, req.body, oldSecret, signatureHeader),
    ).toBe(true);
  });

  it.each([undefined, 'auto', Buffer.alloc(32, 1).toString('base64')])(
    'provisions the original %s secret with an encrypting vault and preserves encrypted queued snapshots',
    async (secret) => {
      const key = randomBytes(32);
      const vault = {
        async encrypt(value: string): Promise<string> {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', key, iv);
          const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
          return `gcm:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
        },
        async decrypt(value: string): Promise<string> {
          if (!value.startsWith('gcm:')) throw new Error('Expected encrypted signing material');
          const bytes = Buffer.from(value.slice(4), 'base64');
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
        },
      };
      const encryptedModule = await Test.createTestingModule({
        imports: [WebhookModule.forRoot({
          prisma,
          secretVault: vault,
          polling: { enabled: false, batchSize: 10 },
          allowPrivateUrls: true,
        })],
      }).compile();

      try {
        await encryptedModule.init();
        const endpoints = encryptedModule.get(WebhookEndpointAdminService);
        const publisher = encryptedModule.get(WebhookService);
        const worker = encryptedModule.get(WebhookDeliveryWorker);
        const endpoint = await endpoints.createEndpoint({
          url: `http://localhost:${mockServerPort}/encrypted`,
          events: ['order.created'], tenantId: 'encrypted-tenant', secret,
        });
        expect(Buffer.from(endpoint.secret, 'base64')).toHaveLength(32);
        if (secret && secret !== 'auto') expect(endpoint.secret).toBe(secret);
        expect(endpoint.tenantId).toBe('encrypted-tenant');
        const [stored] = await prisma.$queryRaw<Array<{ secret: string }>>`
          SELECT secret FROM webhook_endpoints WHERE id = ${endpoint.id}::uuid`;
        expect(stored.secret).not.toBe(endpoint.secret);
        expect(await vault.decrypt(stored.secret)).toBe(endpoint.secret);
        expect(await endpoints.getEndpoint(endpoint.id)).not.toHaveProperty('secret');
        expect((await endpoints.listEndpoints('encrypted-tenant'))[0]).not.toHaveProperty('secret');

        const firstEvent = await publisher.sendToTenant('encrypted-tenant', new TestOrderEvent('before-rotation'));
        const replacement = new WebhookSigner().generateSecret();
        const rotated = await endpoints.rotateSecret(endpoint.id, {
          secret: replacement, previousSecretExpiresAt: new Date(Date.now() + 60_000),
        });
        expect(rotated!.secret).toBe(replacement);
        const [afterRotation] = await prisma.$queryRaw<Array<{ secret: string; previous_secret: string }>>`
          SELECT secret, previous_secret FROM webhook_endpoints WHERE id = ${endpoint.id}::uuid`;
        expect(afterRotation.secret).not.toBe(replacement);
        expect(await vault.decrypt(afterRotation.secret)).toBe(replacement);
        expect(afterRotation.previous_secret).toBe(stored.secret);
        const secondEvent = await publisher.sendToTenant('encrypted-tenant', new TestOrderEvent('after-rotation'));
        const snapshots = await prisma.$queryRaw<Array<{
          event_id: string; signing_secret_snapshot: string; secondary_signing_secret_snapshot: string | null;
        }>>`
          SELECT event_id, signing_secret_snapshot, secondary_signing_secret_snapshot
          FROM webhook_deliveries WHERE endpoint_id = ${endpoint.id}::uuid`;
        expect(snapshots).toEqual(expect.arrayContaining([
          { event_id: firstEvent, signing_secret_snapshot: stored.secret, secondary_signing_secret_snapshot: null },
          { event_id: secondEvent, signing_secret_snapshot: afterRotation.secret, secondary_signing_secret_snapshot: stored.secret },
        ]));
        expect(snapshots).toHaveLength(2);

        await worker.poll();
        expect(receivedRequests).toHaveLength(2);
        const signer = new WebhookSigner();
        for (const eventId of [firstEvent, secondEvent]) {
          const request = receivedRequests.find((item) => item.headers['webhook-id'] === eventId)!;
          const timestamp = Number(request.headers['webhook-timestamp']);
          const signature = request.headers['webhook-signature'] as string;
          expect(signer.verify(eventId, timestamp, request.body, endpoint.secret, signature)).toBe(true);
          expect(signer.verify(eventId, timestamp, request.body, replacement, signature)).toBe(eventId === secondEvent);
        }
        const readBack = await endpoints.getEndpoint(endpoint.id);
        expect(readBack).not.toHaveProperty('secret');
        expect(readBack).not.toHaveProperty('previousSecret');
      } finally {
        await encryptedModule.close();
      }
    },
  );
});
