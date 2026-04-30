import { PrismaEndpointRepository } from './prisma-endpoint.repository';
import { ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED } from '../webhook.constants';

describe('PrismaEndpointRepository', () => {
  describe('resetFailures', () => {
    it('only clears disabled state when the circuit breaker disabled the endpoint', async () => {
      const prisma = {
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const repo = new PrismaEndpointRepository(prisma);

      await repo.resetFailures('endpoint-1');

      const sql = (prisma.$executeRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      const values = prisma.$executeRaw.mock.calls[0].slice(1);
      expect(sql).toContain('active = CASE WHEN disabled_reason =');
      expect(sql).toContain('disabled_at = CASE WHEN disabled_reason =');
      expect(sql).toContain('disabled_reason = CASE WHEN disabled_reason =');
      expect(sql).not.toContain('active = true');
      expect(values).toContain(ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED);
    });
  });

  describe('disableEndpoint', () => {
    it('returns true when the endpoint transitions from active to inactive', async () => {
      const prisma = {
        $executeRaw: jest.fn().mockResolvedValue(1),
      };
      const repo = new PrismaEndpointRepository(prisma);

      await expect(
        repo.disableEndpoint(
          'endpoint-1',
          ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
        ),
      ).resolves.toBe(true);
    });

    it('returns false when the endpoint was already inactive or missing', async () => {
      const prisma = {
        $executeRaw: jest.fn().mockResolvedValue(0),
      };
      const repo = new PrismaEndpointRepository(prisma);

      await expect(
        repo.disableEndpoint(
          'endpoint-1',
          ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
        ),
      ).resolves.toBe(false);
    });
  });

  describe('recoverEligibleEndpoints', () => {
    it('only recovers endpoints disabled by the circuit breaker', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([]),
      };
      const repo = new PrismaEndpointRepository(prisma);

      await repo.recoverEligibleEndpoints(30);

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join(' ');
      const values = prisma.$queryRaw.mock.calls[0].slice(1);
      expect(sql).toContain('disabled_reason =');
      expect(values).toContain(ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED);
    });
  });
});
