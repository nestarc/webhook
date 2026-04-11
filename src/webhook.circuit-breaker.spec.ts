import { WebhookCircuitBreaker } from './webhook.circuit-breaker';

function createMockPrisma() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
}

describe('WebhookCircuitBreaker', () => {
  let cb: WebhookCircuitBreaker;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    cb = new WebhookCircuitBreaker({
      prisma,
      circuitBreaker: {
        failureThreshold: 3,
        cooldownMinutes: 30,
      },
    });
  });

  describe('afterDelivery — success', () => {
    it('should reset failures on success', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      await cb.afterDelivery('ep-1', true);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('afterDelivery — failure below threshold', () => {
    it('should increment failures without disabling', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ consecutive_failures: 2 }]);

      await cb.afterDelivery('ep-1', false);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      // Should NOT call executeRaw to disable (only the increment query)
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
    });
  });

  describe('afterDelivery — failure at threshold', () => {
    it('should disable endpoint when threshold reached', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ consecutive_failures: 3 }]);
      prisma.$executeRaw.mockResolvedValueOnce(1); // disable endpoint

      await cb.afterDelivery('ep-1', false);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });
  });

  describe('recoverEligibleEndpoints', () => {
    it('should recover endpoints past cooldown', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'ep-1' },
        { id: 'ep-2' },
      ]);

      const count = await cb.recoverEligibleEndpoints();

      expect(count).toBe(2);
    });

    it('should return 0 when no endpoints to recover', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      const count = await cb.recoverEligibleEndpoints();

      expect(count).toBe(0);
    });
  });
});
