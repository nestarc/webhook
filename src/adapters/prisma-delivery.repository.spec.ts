import { PrismaDeliveryRepository } from './prisma-delivery.repository';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';

describe('PrismaDeliveryRepository', () => {
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
