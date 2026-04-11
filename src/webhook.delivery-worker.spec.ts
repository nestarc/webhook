import { WebhookDeliveryWorker } from './webhook.delivery-worker';
import { WebhookSigner } from './webhook.signer';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { DEFAULT_BACKOFF_SCHEDULE } from './webhook.constants';

function createMockPrisma() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  };
}

describe('WebhookDeliveryWorker', () => {
  let worker: WebhookDeliveryWorker;
  let prisma: ReturnType<typeof createMockPrisma>;
  let signer: WebhookSigner;
  let circuitBreaker: jest.Mocked<WebhookCircuitBreaker>;

  beforeEach(() => {
    prisma = createMockPrisma();
    signer = new WebhookSigner();

    circuitBreaker = {
      afterDelivery: jest.fn().mockResolvedValue(undefined),
      recoverEligibleEndpoints: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<WebhookCircuitBreaker>;

    worker = new WebhookDeliveryWorker(
      {
        prisma,
        delivery: { timeout: 5000, maxRetries: 3, jitter: false },
        polling: { batchSize: 10 },
      },
      signer,
      circuitBreaker,
    );
  });

  describe('poll', () => {
    it('should do nothing when no pending deliveries', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]); // claim query returns empty

      await worker.poll();

      // recover + claim query
      expect(circuitBreaker.recoverEligibleEndpoints).toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should process deliveries and mark as SENT on success', async () => {
      const delivery = {
        id: 'd-1',
        event_id: 'evt-1',
        endpoint_id: 'ep-1',
        attempts: 0,
        max_attempts: 3,
      };

      // Claim query
      prisma.$queryRaw.mockResolvedValueOnce([delivery]);
      // Enrich query
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          ...delivery,
          url: 'https://httpbin.org/status/200',
          secret: Buffer.from('secret').toString('base64'),
          event_type: 'test.event',
          payload: { key: 'value' },
        },
      ]);
      // Mark sent
      prisma.$executeRaw.mockResolvedValue(1);

      // Mock fetch
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('OK'),
      });

      await worker.poll();

      expect(prisma.$executeRaw).toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-1', true);
    });

    it('should schedule retry on failure with attempts remaining', async () => {
      const delivery = {
        id: 'd-2',
        event_id: 'evt-2',
        endpoint_id: 'ep-2',
        attempts: 0,
        max_attempts: 3,
      };

      prisma.$queryRaw.mockResolvedValueOnce([delivery]);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          ...delivery,
          url: 'https://example.com/fail',
          secret: Buffer.from('secret').toString('base64'),
          event_type: 'test.event',
          payload: {},
        },
      ]);
      prisma.$executeRaw.mockResolvedValue(1);

      global.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      });

      await worker.poll();

      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-2', false);
    });

    it('should mark as FAILED when max retries exhausted', async () => {
      const delivery = {
        id: 'd-3',
        event_id: 'evt-3',
        endpoint_id: 'ep-3',
        attempts: 2, // already 2, max is 3 → this attempt (3rd) is final
        max_attempts: 3,
      };

      prisma.$queryRaw.mockResolvedValueOnce([delivery]);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          ...delivery,
          url: 'https://example.com/fail',
          secret: Buffer.from('secret').toString('base64'),
          event_type: 'test.event',
          payload: {},
        },
      ]);
      prisma.$executeRaw.mockResolvedValue(1);

      global.fetch = jest.fn().mockResolvedValue({
        status: 500,
        text: () => Promise.resolve('error'),
      });

      await worker.poll();

      // Should have called markFailed (status=FAILED)
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-3', false);
    });
  });

  describe('backoff calculation', () => {
    it('should follow the backoff schedule', () => {
      // Access the private method via any cast for testing
      const calcNext = (worker as any).calculateNextAttempt.bind(worker);

      // With jitter disabled, the delay should exactly match the schedule
      for (let i = 0; i < DEFAULT_BACKOFF_SCHEDULE.length; i++) {
        const next: Date = calcNext(i + 1);
        const delayMs = next.getTime() - Date.now();
        const expectedMs = DEFAULT_BACKOFF_SCHEDULE[i] * 1000;
        // Allow 100ms tolerance for execution time
        expect(delayMs).toBeGreaterThan(expectedMs - 100);
        expect(delayMs).toBeLessThan(expectedMs + 100);
      }
    });
  });

  describe('recovery', () => {
    it('should call recoverEligibleEndpoints even when no pending deliveries', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]); // no pending deliveries

      await worker.poll();

      expect(circuitBreaker.recoverEligibleEndpoints).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency guard', () => {
    it('should not run concurrent polls', async () => {
      // Make the first poll hang by never resolving the recovery call
      let resolveRecovery!: () => void;
      circuitBreaker.recoverEligibleEndpoints.mockReturnValueOnce(
        new Promise<number>((resolve) => {
          resolveRecovery = () => resolve(0);
        }),
      );

      const poll1 = worker.poll();
      // Second poll should skip because isPolling is true
      await worker.poll();

      // Only one recoverEligibleEndpoints call (from poll1)
      expect(circuitBreaker.recoverEligibleEndpoints).toHaveBeenCalledTimes(1);

      resolveRecovery();
      prisma.$queryRaw.mockResolvedValueOnce([]); // no deliveries
      await poll1;
    });
  });

  describe('graceful shutdown', () => {
    it('should set shutdown flag', async () => {
      await worker.onModuleDestroy();
      expect((worker as any).isShuttingDown).toBe(true);
    });

    it('should skip poll when shutting down', async () => {
      await worker.onModuleDestroy();
      await worker.poll();

      // Should not have made any DB calls
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
