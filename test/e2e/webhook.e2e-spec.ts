import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { WebhookModule } from '../../src/webhook.module';
import { WebhookService } from '../../src/webhook.service';
import { WebhookAdminService } from '../../src/webhook.admin.service';
import { WebhookDeliveryWorker } from '../../src/webhook.delivery-worker';
import { WebhookEvent } from '../../src/webhook.event';
import { WebhookSigner } from '../../src/webhook.signer';

class TestOrderEvent extends WebhookEvent {
  static readonly eventType = 'order.created';
  constructor(public readonly orderId: string) {
    super();
  }
}

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://webhook_test:webhook_test@localhost:5433/webhook_test';

describe('Webhook E2E', () => {
  let module: TestingModule;
  let prisma: PrismaClient;
  let webhookService: WebhookService;
  let adminService: WebhookAdminService;
  let deliveryWorker: WebhookDeliveryWorker;
  let mockServer: http.Server;
  let mockServerPort: number;
  let receivedRequests: Array<{
    headers: http.IncomingHttpHeaders;
    body: string;
  }>;
  let serverResponseStatus: number;

  beforeAll(async () => {
    // 1. Set up Prisma
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
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
            interval: 60_000, // Don't auto-poll, we'll call manually
            batchSize: 10,
          },
          allowPrivateUrls: true, // E2E tests use localhost
        }),
      ],
    }).compile();

    webhookService = module.get(WebhookService);
    adminService = module.get(WebhookAdminService);
    deliveryWorker = module.get(WebhookDeliveryWorker);

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
});
