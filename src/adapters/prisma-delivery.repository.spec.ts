import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaDeliveryRepository } from './prisma-delivery.repository';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';

describe('PrismaDeliveryRepository', () => {
  describe('createDeliveriesInTransaction', () => {
    it('binds selected endpoint ids to the persisted event tenant and event type', async () => {
      const tx = {
        $executeRawUnsafe: jest.fn().mockResolvedValue(1),
      };
      const repo = new PrismaDeliveryRepository({});

      await repo.createDeliveriesInTransaction(
        tx as never,
        'event-1',
        ['endpoint-1', 'endpoint-2'],
        5,
      );

      const [query] = tx.$executeRawUnsafe.mock.calls[0];
      expect(query).toContain('JOIN webhook_events ev ON ev.id = $1::uuid');
      expect(query).toContain('e.active = true');
      expect(query).toContain('(ev.tenant_id IS NULL OR e.tenant_id = ev.tenant_id)');
      expect(query).toContain("(ev.event_type = ANY(e.events) OR '*' = ANY(e.events))");
    });
  });

  describe('schema indexes', () => {
    it('declares partial indexes for runnable pending and sending scans', () => {
      const createTablesSql = readFileSync(
        join(__dirname, '..', 'sql', 'create-webhook-tables.sql'),
        'utf8',
      );
      const migrationSql = readFileSync(
        join(__dirname, '..', 'sql', 'migrations', 'v0.12.0.sql'),
        'utf8',
      );

      for (const sql of [createTablesSql, migrationSql]) {
        expect(sql).toContain('webhook_deliveries_runnable_pending_idx');
        expect(sql).toContain('ON webhook_deliveries (next_attempt_at, id)');
        expect(sql).toContain("WHERE status = 'PENDING'");
        expect(sql).toContain('webhook_deliveries_sending_claimed_idx');
        expect(sql).toContain('ON webhook_deliveries (claimed_at, id)');
        expect(sql).toContain("WHERE status = 'SENDING'");
      }
    });

    it('declares v0.13.0 idempotency and retention schema additions', () => {
      const createTablesSql = readFileSync(
        join(__dirname, '..', 'sql', 'create-webhook-tables.sql'),
        'utf8',
      );
      const migrationSql = readFileSync(
        join(__dirname, '..', 'sql', 'migrations', 'v0.13.0.sql'),
        'utf8',
      );

      for (const sql of [createTablesSql, migrationSql]) {
        expect(sql).toContain('idempotency_key');
        expect(sql).toContain('correlation_id');
        expect(sql).toContain('payload_purged_at');
        expect(sql).toContain('webhook_events_idempotency_key_idx');
      }
    });
  });

  describe('attempt logging', () => {
    it('writes delivery state and attempt log in the same transaction', async () => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const prisma = {
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: jest.fn(async (fn: (transaction: typeof tx) => Promise<void>) =>
          fn(tx),
        ),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await repo.markSent('delivery-1', 2, {
        success: true,
        statusCode: 204,
        body: 'OK',
        latencyMs: 42,
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    });

    it('rejects when attempt log insert fails', async () => {
      const auditError = new Error('attempt log failed');
      const tx = {
        $executeRaw: jest
          .fn()
          .mockResolvedValueOnce(1)
          .mockRejectedValueOnce(auditError),
      };
      const prisma = {
        $executeRaw: jest
          .fn()
          .mockResolvedValueOnce(1)
          .mockRejectedValueOnce(auditError),
        $transaction: jest.fn(async (fn: (transaction: typeof tx) => Promise<void>) =>
          fn(tx),
        ),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(
        repo.markFailed('delivery-1', 3, {
          success: false,
          statusCode: 500,
          body: 'Internal Server Error',
          latencyMs: 100,
          error: 'server error',
        }),
      ).rejects.toThrow('attempt log failed');
    });

    it('clears next attempt timestamp when marking a delivery failed', async () => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const prisma = {
        $transaction: jest.fn(async (fn: (transaction: typeof tx) => Promise<void>) =>
          fn(tx),
        ),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await repo.markFailed('delivery-1', 1, {
        success: false,
        statusCode: 410,
        body: 'Gone',
        latencyMs: 100,
      });

      const sql = (tx.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(sql).toContain('next_attempt_at = NULL');
    });
  });

  describe('recoverStaleSending', () => {
    it('counts stale recovered deliveries as attempts and records attempt logs', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'delivery-1' }]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(repo.recoverStaleSending(5)).resolves.toBe(1);

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(sql).toContain('attempts = attempts + 1');
      expect(sql).toContain('attempts + 1 >= max_attempts');
      expect(sql).toContain('claimed_at < NOW() -');
      expect(sql).toContain('webhook_delivery_attempts');
    });
  });

  describe('claimPendingDeliveries', () => {
    it('returns claimed deliveries with camelCase field aliases', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await repo.claimPendingDeliveries(10);

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(sql).toContain('event_id AS "eventId"');
      expect(sql).toContain('endpoint_id AS "endpointId"');
      expect(sql).toContain('max_attempts AS "maxAttempts"');
    });
  });

  describe('getBacklogSummary', () => {
    it('returns default zero counts when the aggregate query returns no rows', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(repo.getBacklogSummary()).resolves.toEqual({
        pendingCount: 0,
        sendingCount: 0,
        runnablePendingCount: 0,
        oldestPendingAgeMs: null,
        oldestRunnableAgeMs: null,
      });
    });

    it('uses backlog diagnostic aliases expected by the public port', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            pendingCount: 3,
            sendingCount: 2,
            runnablePendingCount: 1,
            oldestPendingAgeMs: 12_000,
            oldestRunnableAgeMs: 4_000,
          },
        ]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(repo.getBacklogSummary()).resolves.toEqual({
        pendingCount: 3,
        sendingCount: 2,
        runnablePendingCount: 1,
        oldestPendingAgeMs: 12_000,
        oldestRunnableAgeMs: 4_000,
      });

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(sql).toContain('AS "pendingCount"');
      expect(sql).toContain('AS "sendingCount"');
      expect(sql).toContain('AS "runnablePendingCount"');
      expect(sql).toContain('AS "oldestPendingAgeMs"');
      expect(sql).toContain('AS "oldestRunnableAgeMs"');
      expect(sql).toContain("status = 'PENDING'");
      expect(sql).toContain("status = 'SENDING'");
      expect(sql).not.toContain('::int');
    });

    it('normalizes wide aggregate values to JavaScript numbers', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            pendingCount: BigInt(3),
            sendingCount: '2',
            runnablePendingCount: BigInt(1),
            oldestPendingAgeMs: '2147483648',
            oldestRunnableAgeMs: BigInt(3_000_000_000),
          },
        ]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(repo.getBacklogSummary()).resolves.toEqual({
        pendingCount: 3,
        sendingCount: 2,
        runnablePendingCount: 1,
        oldestPendingAgeMs: 2_147_483_648,
        oldestRunnableAgeMs: 3_000_000_000,
      });
    });
  });

  describe('enrichDeliveries', () => {
    it('returns pending deliveries with camelCase field aliases and required additional secrets', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await repo.enrichDeliveries(['delivery-1']);

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      expect(sql).toContain('d.event_id AS "eventId"');
      expect(sql).toContain('d.endpoint_id AS "endpointId"');
      expect(sql).toContain('d.max_attempts AS "maxAttempts"');
      expect(sql).toContain('e.tenant_id::text AS "tenantId"');
      expect(sql).toContain('ev.event_type AS "eventType"');
      expect(sql).toContain('AS "additionalSecrets"');
    });
  });

  describe('getDeliveryLogs', () => {
    it('selects tenant ID and destination URL for public delivery records', async () => {
      const prisma = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await repo.getDeliveryLogs('endpoint-1');

      const query = prisma.$queryRawUnsafe.mock.calls[0][0] as string;
      expect(query).toContain('ep.tenant_id::text AS "tenantId"');
      expect(query).toContain('AS "destinationUrl"');
    });
  });

  describe('retryDelivery', () => {
    it('requeues failed deliveries and grants one additional manual attempt', async () => {
      const prisma = {
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(
        repo.retryDelivery('delivery-1', { reason: 'customer requested replay' }),
      ).resolves.toBe(true);

      const sql = (prisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(sql).toContain("status = 'PENDING'");
      expect(sql).toContain('next_attempt_at = NOW()');
      expect(sql).toContain('max_attempts = GREATEST(max_attempts, attempts + 1)');
      expect(sql).toContain("status = 'FAILED'");
    });
  });

  describe('response body redaction', () => {
    it('sanitizes response bodies before storing delivery and attempt rows', async () => {
      const tx = {
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const prisma = {
        $transaction: jest.fn(async (fn: (transaction: typeof tx) => Promise<void>) =>
          fn(tx),
        ),
      };
      const sanitizeResponseBody = jest.fn().mockReturnValue(null);
      const repo = new PrismaDeliveryRepository(prisma, undefined, {
        sanitizeResponseBody,
      });

      await repo.markFailed('delivery-1', 1, {
        success: false,
        statusCode: 500,
        body: 'token=secret',
        latencyMs: 100,
        error: 'server error',
      });

      expect(sanitizeResponseBody).toHaveBeenCalledWith('token=secret', {
        deliveryId: 'delivery-1',
        endpointId: null,
        eventId: null,
        statusCode: 500,
      });
      expect(tx.$executeRaw.mock.calls[0]).toContain(null);
      expect(tx.$executeRaw.mock.calls[1]).toContain(null);
    });
  });

  describe('purgeExpiredData', () => {
    it('purges expired payload and response body data and returns normalized counts', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            eventsPurged: BigInt(1),
            deliveriesPurged: '2',
            attemptsPurged: 3,
          },
        ]),
      };
      const repo = new PrismaDeliveryRepository(prisma);
      const now = new Date('2026-06-23T00:00:00.000Z');

      await expect(
        repo.purgeExpiredData(
          {
            eventPayloadRetentionDays: 30,
            deliveryResponseBodyRetentionDays: 14,
            attemptResponseBodyRetentionDays: 7,
          },
          now,
        ),
      ).resolves.toEqual({
        eventsPurged: 1,
        deliveriesPurged: 2,
        attemptsPurged: 3,
      });

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(sql).toContain("payload = '{}'::jsonb");
      expect(sql).toContain('payload_purged_at');
      expect(sql).toContain("status IN ('PENDING', 'SENDING')");
      expect(sql).toContain('response_body = NULL');
    });
  });

  describe('retryFailedDeliveries', () => {
    it('defaults bulk retry to a bounded limit and returns normalized counts', async () => {
      const prisma = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([
          {
            matched: BigInt(3),
            retried: '2',
            skipped: 1,
          },
        ]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(
        repo.retryFailedDeliveries({
          endpointId: 'endpoint-1',
          eventType: 'order.created',
          since: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ).resolves.toEqual({ matched: 3, retried: 2, skipped: 1 });

      const [query, ...values] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(query).toContain("d.status = 'FAILED'");
      expect(query).toContain('LIMIT $');
      expect(query).toContain('max_attempts = GREATEST(max_attempts, attempts + 1)');
      expect(values).toContain('endpoint-1');
      expect(values).toContain('order.created');
      expect(values).toContain(100);
    });

    it('rejects unsafe bulk retry limits', async () => {
      const repo = new PrismaDeliveryRepository({ $queryRawUnsafe: jest.fn() });

      await expect(
        repo.retryFailedDeliveries({ limit: 1001 }),
      ).rejects.toThrow('Bulk retry limit must be between 1 and 1000');
    });
  });

  describe('replayEvent', () => {
    it('creates replay deliveries for active endpoints using current endpoint snapshots', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            eventId: 'event-1',
            sourceEventCount: 1,
            deliveriesCreated: BigInt(2),
            endpointIds: ['endpoint-1', 'endpoint-2'],
          },
        ]),
      };
      const repo = new PrismaDeliveryRepository(prisma);

      await expect(
        repo.replayEvent('event-1', {
          tenantId: 'tenant_123',
          endpointIds: ['endpoint-1', 'endpoint-2'],
          reason: 'customer support replay',
        }),
      ).resolves.toEqual({
        eventId: 'event-1',
        deliveriesCreated: 2,
        endpointIds: ['endpoint-1', 'endpoint-2'],
      });

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(sql).toContain('payload_purged_at IS NULL');
      expect(sql).toContain('e.active = true');
      expect(sql).toContain('ev.tenant_id =');
      expect(sql).toContain('(ev.tenant_id IS NULL OR e.tenant_id = ev.tenant_id)');
      expect(sql).toContain('e.url');
      expect(sql).toContain('e.secret');
      expect(sql).toContain('array_agg');
    });
  });

  describe('secret vault enrichment', () => {
    it('starts vault decryptions for the full batch without waiting on earlier rows', async () => {
      const rows = [
        {
          id: 'delivery-1',
          secret: 'primary-1',
          additionalSecrets: ['secondary-1'],
        },
        {
          id: 'delivery-2',
          secret: 'primary-2',
          additionalSecrets: [],
        },
      ];
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue(rows),
      };
      const started: string[] = [];
      const resolvers = new Map<string, () => void>();
      const vault: WebhookSecretVault = {
        encrypt: jest.fn(async (secret: string) => secret),
        decrypt: jest.fn(
          (secret: string) =>
            new Promise<string>((resolve) => {
              started.push(secret);
              resolvers.set(secret, () => resolve(`decrypted:${secret}`));
            }),
        ),
      };
      const repo = new PrismaDeliveryRepository(prisma, vault);

      const enrichPromise = repo.enrichDeliveries(['delivery-1', 'delivery-2']);
      await Promise.resolve();

      expect(started).toEqual(
        expect.arrayContaining(['primary-1', 'secondary-1', 'primary-2']),
      );

      for (const resolve of resolvers.values()) {
        resolve();
      }
      await enrichPromise;
    });
  });
});
