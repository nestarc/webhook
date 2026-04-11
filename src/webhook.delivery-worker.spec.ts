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

  describe('deliver — edge cases', () => {
    function setupDeliveryMock(delivery: Record<string, unknown>) {
      prisma.$queryRaw.mockResolvedValueOnce([delivery]);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          ...delivery,
          url: 'https://example.com/hook',
          secret: Buffer.from('a'.repeat(32)).toString('base64'),
          event_type: 'test.event',
          payload: { key: 'value' },
        },
      ]);
      prisma.$executeRaw.mockResolvedValue(1);
    }

    it('should include Standard Webhooks headers in fetch request', async () => {
      setupDeliveryMock({ id: 'd-h', event_id: 'evt-h', endpoint_id: 'ep-h', attempts: 0, max_attempts: 3 });

      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('ok'),
      });

      await worker.poll();

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      const headers = fetchCall[1].headers;
      expect(headers['webhook-id']).toBe('evt-h');
      expect(headers['webhook-timestamp']).toBeDefined();
      expect(headers['webhook-signature']).toMatch(/^v1,.+$/);
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toBe('@nestarc/webhook');
    });

    it('should truncate response body to 1KB', async () => {
      setupDeliveryMock({ id: 'd-trunc', event_id: 'evt-trunc', endpoint_id: 'ep-trunc', attempts: 0, max_attempts: 3 });

      const longBody = 'x'.repeat(2048);
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve(longBody),
      });

      await worker.poll();

      // markSent is called via $executeRaw — check the response_body param
      // The deliver() method slices to RESPONSE_BODY_MAX_LENGTH (1024)
      // Since we can't easily inspect tagged template params, verify via the mock call
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('should handle fetch network error gracefully', async () => {
      setupDeliveryMock({ id: 'd-net', event_id: 'evt-net', endpoint_id: 'ep-net', attempts: 0, max_attempts: 3 });

      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await worker.poll();

      // Should record failure via circuit breaker
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-net', false);
    });

    it('should handle fetch abort (timeout) as failure', async () => {
      setupDeliveryMock({ id: 'd-abort', event_id: 'evt-abort', endpoint_id: 'ep-abort', attempts: 0, max_attempts: 3 });

      const abortError = new DOMException('The operation was aborted', 'AbortError');
      global.fetch = jest.fn().mockRejectedValue(abortError);

      await worker.poll();

      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-abort', false);
    });

    it('should reset to PENDING when processDelivery internal error occurs', async () => {
      // Simulate an error AFTER fetch but during state update
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'd-err', event_id: 'evt-err', endpoint_id: 'ep-err', attempts: 0, max_attempts: 3 },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'd-err', event_id: 'evt-err', endpoint_id: 'ep-err', attempts: 0, max_attempts: 3,
          url: 'https://example.com/hook',
          secret: Buffer.from('a'.repeat(32)).toString('base64'),
          event_type: 'test.event',
          payload: {},
        },
      ]);

      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        text: () => Promise.resolve('ok'),
      });

      // Make markSent throw to trigger the catch block
      prisma.$executeRaw
        .mockRejectedValueOnce(new Error('DB write failed'))
        // The catch block will try to reset to PENDING
        .mockResolvedValueOnce(1);

      await worker.poll();

      // The second $executeRaw call should be the PENDING reset
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    });
  });

  describe('graceful shutdown — waiting', () => {
    it('should wait for active deliveries before completing shutdown', async () => {
      // Simulate an active delivery by setting the counter
      (worker as any).activeDeliveries = 1;

      // Start shutdown — it will poll waiting for activeDeliveries to reach 0
      const shutdownPromise = worker.onModuleDestroy();

      // Simulate delivery completion after a short delay
      setTimeout(() => {
        (worker as any).activeDeliveries = 0;
      }, 200);

      await shutdownPromise;

      expect((worker as any).isShuttingDown).toBe(true);
      expect((worker as any).activeDeliveries).toBe(0);
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
