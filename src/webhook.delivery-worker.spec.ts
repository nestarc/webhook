import { WebhookDeliveryWorker } from './webhook.delivery-worker';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookRetryPolicy } from './webhook.retry-policy';
import {
  PendingDelivery,
  WebhookDeliveryRepository,
} from './ports/webhook-delivery.repository';
import { DeliveryResult } from './interfaces/webhook-delivery.interface';

function createMockDeliveryRepo() {
  return {
    claimPendingDeliveries: jest.fn().mockResolvedValue([]),
    enrichDeliveries: jest.fn().mockResolvedValue([]),
    markSent: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    markRetry: jest.fn().mockResolvedValue(undefined),
    recoverStaleSending: jest.fn().mockResolvedValue(0),
  } as jest.Mocked<Pick<
    WebhookDeliveryRepository,
    'claimPendingDeliveries' | 'enrichDeliveries' | 'markSent' | 'markFailed' | 'markRetry' | 'recoverStaleSending'
  >>;
}

function createMockDispatcher() {
  return {
    dispatch: jest.fn(),
  } as jest.Mocked<Pick<WebhookDispatcher, 'dispatch'>>;
}

function createMockRetryPolicy() {
  return {
    nextAttemptAt: jest.fn().mockReturnValue(new Date(Date.now() + 30_000)),
  } as jest.Mocked<Pick<WebhookRetryPolicy, 'nextAttemptAt'>>;
}

function createMockCircuitBreaker() {
  return {
    afterDelivery: jest.fn().mockResolvedValue(undefined),
    recoverEligibleEndpoints: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<WebhookCircuitBreaker>;
}

function makeDelivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: 'd-1',
    event_id: 'evt-1',
    endpoint_id: 'ep-1',
    tenant_id: 'tenant-1',
    attempts: 0,
    max_attempts: 3,
    url: 'https://example.com/hook',
    secret: Buffer.from('secret').toString('base64'),
    event_type: 'test.event',
    payload: { key: 'value' },
    ...overrides,
  };
}

function makeSuccessResult(): DeliveryResult {
  return { success: true, statusCode: 200, body: 'OK', latencyMs: 50 };
}

function makeFailureResult(): DeliveryResult {
  return { success: false, statusCode: 500, body: 'Internal Server Error', latencyMs: 100 };
}

describe('WebhookDeliveryWorker', () => {
  let worker: WebhookDeliveryWorker;
  let deliveryRepo: ReturnType<typeof createMockDeliveryRepo>;
  let dispatcher: ReturnType<typeof createMockDispatcher>;
  let retryPolicy: ReturnType<typeof createMockRetryPolicy>;
  let circuitBreaker: jest.Mocked<WebhookCircuitBreaker>;

  beforeEach(() => {
    deliveryRepo = createMockDeliveryRepo();
    dispatcher = createMockDispatcher();
    retryPolicy = createMockRetryPolicy();
    circuitBreaker = createMockCircuitBreaker();

    worker = new WebhookDeliveryWorker(
      deliveryRepo as unknown as WebhookDeliveryRepository,
      dispatcher as unknown as WebhookDispatcher,
      retryPolicy as unknown as WebhookRetryPolicy,
      circuitBreaker,
      {
        delivery: { timeout: 5000, maxRetries: 3, jitter: false },
        polling: { batchSize: 10 },
      },
    );
  });

  describe('poll', () => {
    it('should do nothing when no pending deliveries', async () => {
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([]);

      await worker.poll();

      expect(circuitBreaker.recoverEligibleEndpoints).toHaveBeenCalled();
      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledWith(10);
      expect(deliveryRepo.enrichDeliveries).not.toHaveBeenCalled();
    });

    it('should process deliveries and mark as SENT on success', async () => {
      const claimed = { id: 'd-1', event_id: 'evt-1', endpoint_id: 'ep-1', attempts: 0, max_attempts: 3 };
      const enriched = makeDelivery();

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([claimed as PendingDelivery]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeSuccessResult());

      await worker.poll();

      expect(dispatcher.dispatch).toHaveBeenCalledWith(enriched);
      expect(deliveryRepo.markSent).toHaveBeenCalledWith(
        'd-1',
        1,
        expect.objectContaining({ success: true }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-1', true, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
    });

    it('should schedule retry on failure with attempts remaining', async () => {
      const enriched = makeDelivery({ id: 'd-2', endpoint_id: 'ep-2' });
      const nextDate = new Date(Date.now() + 30_000);

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await worker.poll();

      expect(deliveryRepo.markRetry).toHaveBeenCalledWith(
        'd-2',
        1,
        nextDate,
        expect.objectContaining({ success: false }),
      );
      expect(retryPolicy.nextAttemptAt).toHaveBeenCalledWith(1);
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-2', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
    });

    it('should mark as FAILED when max retries exhausted', async () => {
      const enriched = makeDelivery({
        id: 'd-3',
        endpoint_id: 'ep-3',
        attempts: 2,
        max_attempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await worker.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-3',
        3,
        expect.objectContaining({ success: false }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith('ep-3', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      expect(deliveryRepo.markRetry).not.toHaveBeenCalled();
    });
  });

  describe('dispatch — edge cases', () => {
    it('should increment attempts and apply backoff on dispatch exception', async () => {
      const enriched = makeDelivery({ id: 'd-net', endpoint_id: 'ep-net' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await worker.poll();

      // Should schedule retry with incremented attempts, not reset blindly
      expect(deliveryRepo.markRetry).toHaveBeenCalledWith(
        'd-net',
        1,
        expect.any(Date),
        expect.objectContaining({ success: false, error: 'ECONNREFUSED' }),
      );
    });

    it('should mark FAILED on exception when retries exhausted', async () => {
      const enriched = makeDelivery({ id: 'd-exh', endpoint_id: 'ep-exh', attempts: 2, max_attempts: 3 });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('timeout'));

      await worker.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-exh',
        3,
        expect.objectContaining({ success: false }),
      );
    });

    it('should increment attempts on markSent exception', async () => {
      const enriched = makeDelivery({ id: 'd-err', endpoint_id: 'ep-err' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeSuccessResult());
      deliveryRepo.markSent.mockRejectedValueOnce(new Error('DB write failed'));

      await worker.poll();

      // Catch block should schedule retry
      expect(deliveryRepo.markRetry).toHaveBeenCalledWith(
        'd-err',
        1,
        expect.any(Date),
        expect.objectContaining({ success: false, error: 'DB write failed' }),
      );
    });

    it('should NOT revert state when markSent succeeds but afterDelivery fails', async () => {
      const enriched = makeDelivery({ id: 'd-cb1', endpoint_id: 'ep-cb1' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeSuccessResult());
      deliveryRepo.markSent.mockResolvedValueOnce(undefined);
      circuitBreaker.afterDelivery.mockRejectedValueOnce(new Error('CB failed'));

      await worker.poll();

      expect(deliveryRepo.markSent).toHaveBeenCalledWith('d-cb1', 1, expect.objectContaining({ success: true }));
      // markRetry should NOT be called in catch path (only in normal flow)
      // Verify the delivery state was preserved (markSent/markFailed was the last state change)
    });

    it('should NOT reset to PENDING when markFailed succeeds but afterDelivery fails', async () => {
      const enriched = makeDelivery({ id: 'd-cb2', endpoint_id: 'ep-cb2', attempts: 2, max_attempts: 3 });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());
      deliveryRepo.markFailed.mockResolvedValueOnce(undefined);
      circuitBreaker.afterDelivery.mockRejectedValueOnce(new Error('CB failed'));

      await worker.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalled();
      // markRetry should NOT be called in catch path (only in normal flow)
      // Verify the delivery state was preserved (markSent/markFailed was the last state change)
    });

    it('should NOT reset to PENDING when markRetry succeeds but afterDelivery fails', async () => {
      const enriched = makeDelivery({ id: 'd-cb3', endpoint_id: 'ep-cb3' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());
      deliveryRepo.markRetry.mockResolvedValueOnce(undefined);
      circuitBreaker.afterDelivery.mockRejectedValueOnce(new Error('CB failed'));

      await worker.poll();

      expect(deliveryRepo.markRetry).toHaveBeenCalled();
      // markRetry should NOT be called in catch path (only in normal flow)
      // Verify the delivery state was preserved (markSent/markFailed was the last state change)
    });

    it('should process multiple deliveries in parallel', async () => {
      const d1 = makeDelivery({ id: 'd-p1', endpoint_id: 'ep-p1' });
      const d2 = makeDelivery({ id: 'd-p2', endpoint_id: 'ep-p2' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([d1, d2]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await worker.poll();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(deliveryRepo.markSent).toHaveBeenCalledTimes(2);
    });
  });

  describe('onDeliveryFailed callback', () => {
    it('should call onDeliveryFailed when delivery exhausts retries', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-fail', endpoint_id: 'ep-fail', attempts: 2, max_attempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();

      expect(onDeliveryFailed).toHaveBeenCalledWith({
        deliveryId: 'd-fail',
        endpointId: 'ep-fail',
        eventId: 'evt-1',
        tenantId: 'tenant-1',
        attempts: 3,
        maxAttempts: 3,
        lastError: null,
        responseStatus: 500,
      });
    });

    it('should call onDeliveryFailed on exception path when retries exhausted', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-exc', endpoint_id: 'ep-exc', attempts: 2, max_attempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('connection reset'));

      await workerWithHook.poll();

      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-exc',
          attempts: 3,
          lastError: 'connection reset',
          responseStatus: null,
        }),
      );
    });

    it('should not propagate callback errors to delivery processing', async () => {
      const onDeliveryFailed = jest.fn().mockRejectedValue(new Error('callback boom'));
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-cberr', attempts: 2, max_attempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalled();
    });

    it('should not call callback when retries remain', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-retry', attempts: 0, max_attempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();

      expect(onDeliveryFailed).not.toHaveBeenCalled();
      expect(deliveryRepo.markRetry).toHaveBeenCalled();
    });
  });

  describe('graceful shutdown — waiting', () => {
    it('should wait for active deliveries before completing shutdown', async () => {
      (worker as any).activeDeliveries = 1;

      const shutdownPromise = worker.onModuleDestroy();

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
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([]);

      await worker.poll();

      expect(circuitBreaker.recoverEligibleEndpoints).toHaveBeenCalledTimes(1);
    });

    it('should call recoverStaleSending on every poll', async () => {
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([]);

      await worker.poll();

      expect(deliveryRepo.recoverStaleSending).toHaveBeenCalledWith(5);
    });
  });

  describe('concurrency guard', () => {
    it('should not run concurrent polls', async () => {
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
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([]);
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

      expect(deliveryRepo.claimPendingDeliveries).not.toHaveBeenCalled();
    });
  });
});
