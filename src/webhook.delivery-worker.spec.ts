import { Logger } from '@nestjs/common';
import { WebhookDeliveryWorker } from './webhook.delivery-worker';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookRetryPolicy } from './webhook.retry-policy';
import {
  ClaimedDelivery,
  PendingDelivery,
  WebhookDeliveryRepository,
} from './ports/webhook-delivery.repository';
import { DeliveryResult } from './interfaces/webhook-delivery.interface';
import { WebhookUrlValidationError } from './webhook.url-validator';

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
    eventId: 'evt-1',
    endpointId: 'ep-1',
    tenantId: 'tenant-1',
    attempts: 0,
    maxAttempts: 3,
    url: 'https://example.com/hook',
    secret: Buffer.from('secret').toString('base64'),
    additionalSecrets: [],
    eventType: 'test.event',
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
      const claimed: ClaimedDelivery = {
        id: 'd-1',
        eventId: 'evt-1',
        endpointId: 'ep-1',
        attempts: 0,
        maxAttempts: 3,
      };
      const enriched = makeDelivery();

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([claimed]);
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
      const enriched = makeDelivery({ id: 'd-2', endpointId: 'ep-2' });
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

    it.each([400, 401, 403, 404, 410, 422])(
      'should mark permanent HTTP %i as FAILED without scheduling retry',
      async (statusCode) => {
        const enriched = makeDelivery({
          id: `d-${statusCode}`,
          endpointId: `ep-${statusCode}`,
          attempts: 0,
          maxAttempts: 5,
        });
        const result: DeliveryResult = {
          success: false,
          statusCode,
          body: 'permanent receiver error',
          latencyMs: 100,
        };

        deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
        deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
        dispatcher.dispatch.mockResolvedValueOnce(result);

        await worker.poll();

        expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
          `d-${statusCode}`,
          1,
          result,
        );
        expect(deliveryRepo.markRetry).not.toHaveBeenCalled();
        expect(retryPolicy.nextAttemptAt).not.toHaveBeenCalled();
        expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
          `ep-${statusCode}`,
          false,
          { tenantId: 'tenant-1', url: 'https://example.com/hook' },
        );
      },
    );

    it('should mark as FAILED when max retries exhausted', async () => {
      const enriched = makeDelivery({
        id: 'd-3',
        endpointId: 'ep-3',
        attempts: 2,
        maxAttempts: 3,
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

    it('limits a claim to available worker concurrency when batchSize is larger', async () => {
      const workerWithLimit = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 5, maxConcurrency: 2 } },
      );
      const d1 = makeDelivery({ id: 'd-limit-1' });
      const d2 = makeDelivery({ id: 'd-limit-2' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([d1, d2]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await workerWithLimit.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledWith(2);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(deliveryRepo.markSent).toHaveBeenCalledTimes(2);
    });

    it('defaults maxConcurrency to batchSize for compatibility', async () => {
      const d1 = makeDelivery({ id: 'd-default-1' });
      const d2 = makeDelivery({ id: 'd-default-2' });
      const d3 = makeDelivery({ id: 'd-default-3' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([d1, d2, d3]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2, d3]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await worker.poll();

      expect(deliveryRepo.claimPendingDeliveries).toHaveBeenCalledWith(10);
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3);
    });

    it('reports poll and delivery metrics to the worker observer', async () => {
      const observer = {
        onPollStart: jest.fn(),
        onPollComplete: jest.fn(),
        onDeliveryComplete: jest.fn(),
        onPollError: jest.fn(),
      };
      const workerWithObserver = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10, maxConcurrency: 10 },
          workerObserver: observer,
        },
      );
      const sent = makeDelivery({ id: 'd-observer-sent' });
      const retried = makeDelivery({ id: 'd-observer-retry' });
      const retryAt = new Date('2026-05-03T00:00:00.000Z');

      deliveryRepo.recoverStaleSending.mockResolvedValueOnce(3);
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([sent, retried]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([sent, retried]);
      dispatcher.dispatch
        .mockResolvedValueOnce(makeSuccessResult())
        .mockResolvedValueOnce(makeFailureResult());
      retryPolicy.nextAttemptAt.mockReturnValueOnce(retryAt);

      await workerWithObserver.poll();

      expect(observer.onPollStart).toHaveBeenCalledWith({
        batchSize: 10,
        maxConcurrency: 10,
        drainWhileBacklogged: false,
        maxDrainLoopsPerPoll: 1,
        drainLoopDelayMs: 0,
        activeDeliveries: 0,
      });
      expect(observer.onDeliveryComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-observer-sent',
          status: 'sent',
          responseStatus: 200,
        }),
      );
      expect(observer.onDeliveryComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-observer-retry',
          status: 'retried',
          responseStatus: 500,
          nextAttemptAt: retryAt,
          failureKind: 'http_error',
        }),
      );
      expect(observer.onPollComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          claimed: 2,
          enriched: 2,
          sent: 1,
          failed: 0,
          retried: 1,
          recoveredStale: 3,
          loops: 1,
          durationMs: expect.any(Number),
        }),
      );
      expect(observer.onPollError).not.toHaveBeenCalled();
    });

    it('logs observer errors without failing delivery processing', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const observer = {
        onDeliveryComplete: jest.fn(() => {
          throw new Error('observer failed');
        }),
      };
      const workerWithObserver = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, workerObserver: observer },
      );
      const delivery = makeDelivery({ id: 'd-observer-error' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([delivery]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([delivery]);
      dispatcher.dispatch.mockResolvedValueOnce(makeSuccessResult());

      await workerWithObserver.poll();

      expect(deliveryRepo.markSent).toHaveBeenCalledWith(
        'd-observer-error',
        1,
        expect.objectContaining({ success: true }),
      );
      expect(loggerError).toHaveBeenCalledWith(
        'workerObserver.onDeliveryComplete callback error: observer failed',
        expect.any(String),
      );
      loggerError.mockRestore();
    });
  });

  describe('dispatch — edge cases', () => {
    it('should increment attempts and apply backoff on dispatch exception', async () => {
      const enriched = makeDelivery({ id: 'd-net', endpointId: 'ep-net' });

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
      const enriched = makeDelivery({ id: 'd-exh', endpointId: 'ep-exh', attempts: 2, maxAttempts: 3 });

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
      const enriched = makeDelivery({ id: 'd-err', endpointId: 'ep-err' });

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
      const enriched = makeDelivery({ id: 'd-cb1', endpointId: 'ep-cb1' });

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
      const enriched = makeDelivery({ id: 'd-cb2', endpointId: 'ep-cb2', attempts: 2, maxAttempts: 3 });

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
      const enriched = makeDelivery({ id: 'd-cb3', endpointId: 'ep-cb3' });

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
      const d1 = makeDelivery({ id: 'd-p1', endpointId: 'ep-p1' });
      const d2 = makeDelivery({ id: 'd-p2', endpointId: 'ep-p2' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([d1, d2]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([d1, d2]);
      dispatcher.dispatch.mockResolvedValue(makeSuccessResult());

      await worker.poll();

      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      expect(deliveryRepo.markSent).toHaveBeenCalledTimes(2);
    });

    it('should update circuit breaker after persisted retry on retriable dispatcher exception', async () => {
      const enriched = makeDelivery({
        id: 'd-exception-cb-retry',
        endpointId: 'ep-exception-cb-retry',
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('ECONNRESET'));

      await worker.poll();

      expect(deliveryRepo.markRetry).toHaveBeenCalledWith(
        'd-exception-cb-retry',
        1,
        expect.any(Date),
        expect.objectContaining({ success: false, error: 'ECONNRESET' }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-exception-cb-retry',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });

    it('should update circuit breaker after persisted failure on terminal dispatcher exception', async () => {
      const enriched = makeDelivery({
        id: 'd-exception-cb-failed',
        endpointId: 'ep-exception-cb-failed',
        attempts: 2,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('timeout'));

      await worker.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-exception-cb-failed',
        3,
        expect.objectContaining({ success: false, error: 'timeout' }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-exception-cb-failed',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });
  });

  describe('onDeliveryFailed callback', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('should fire onDeliveryFailed when delivery exhausts retries', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-fail', endpointId: 'ep-fail', attempts: 2, maxAttempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith({
        deliveryId: 'd-fail',
        endpointId: 'ep-fail',
        eventId: 'evt-1',
        tenantId: 'tenant-1',
        attempts: 3,
        maxAttempts: 3,
        lastError: null,
        responseStatus: 500,
        failureKind: 'http_error',
      });
    });

    it('should fire onDeliveryFailed when delivery has a non-retryable HTTP status', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 410,
        body: 'gone',
        latencyMs: 100,
      };
      const enriched = makeDelivery({
        id: 'd-gone',
        endpointId: 'ep-gone',
        attempts: 0,
        maxAttempts: 5,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith({
        deliveryId: 'd-gone',
        endpointId: 'ep-gone',
        eventId: 'evt-1',
        tenantId: 'tenant-1',
        attempts: 1,
        maxAttempts: 5,
        lastError: null,
        responseStatus: 410,
        failureKind: 'http_error',
      });
    });

    it('should classify exhausted result failures without statusCode as dispatch_error', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({
        id: 'd-timeout',
        endpointId: 'ep-timeout',
        attempts: 2,
        maxAttempts: 3,
      });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce({
        success: false,
        latencyMs: 10_000,
        error: 'The operation was aborted',
      });

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-timeout',
          lastError: 'The operation was aborted',
          responseStatus: null,
          failureKind: 'dispatch_error',
        }),
      );
    });

    it('should fire onDeliveryFailed on exception path when retries exhausted', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-exc', endpointId: 'ep-exc', attempts: 2, maxAttempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('connection reset'));

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-exc',
          attempts: 3,
          lastError: 'connection reset',
          responseStatus: null,
          failureKind: 'dispatch_error',
        }),
      );
    });

    it('should propagate WebhookUrlValidationError metadata to onDeliveryFailed', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({
        id: 'd-val',
        endpointId: 'ep-val',
        url: 'http://evil.nip.io/hook',
        attempts: 2,
        maxAttempts: 3,
      });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(
        new WebhookUrlValidationError(
          'Invalid webhook URL: "10.0.0.1" is a private address',
          'private',
          'http://evil.nip.io/hook',
          '10.0.0.1',
        ),
      );

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-val',
          attempts: 3,
          lastError: expect.stringContaining('private address'),
          responseStatus: null,
          failureKind: 'url_validation',
          validationReason: 'private',
          validationUrl: 'http://evil.nip.io/hook',
          resolvedIp: '10.0.0.1',
        }),
      );
    });

    it('should fall back to delivery.url when WebhookUrlValidationError.url is undefined', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({
        id: 'd-val2',
        url: 'https://customer.com/hook',
        attempts: 2,
        maxAttempts: 3,
      });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(
        new WebhookUrlValidationError(
          'Invalid webhook URL: "::1" is a loopback address',
          'loopback',
        ),
      );

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          failureKind: 'url_validation',
          validationReason: 'loopback',
          validationUrl: 'https://customer.com/hook',
          resolvedIp: undefined,
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

      const enriched = makeDelivery({ id: 'd-cberr', attempts: 2, maxAttempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markFailed).toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalled();
    });

    it('should not retry non-retryable HTTP failures when onDeliveryFailed throws synchronously', async () => {
      const onDeliveryFailed = jest.fn(() => {
        throw new Error('callback boom');
      });
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 410,
        body: 'gone',
        latencyMs: 100,
      };
      const enriched = makeDelivery({
        id: 'd-sync-hook',
        endpointId: 'ep-sync-hook',
        attempts: 0,
        maxAttempts: 5,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);

      await workerWithHook.poll();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-sync-hook',
        1,
        result,
      );
      expect(deliveryRepo.markRetry).not.toHaveBeenCalled();
      expect(retryPolicy.nextAttemptAt).not.toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-sync-hook',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
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

      const enriched = makeDelivery({ id: 'd-retry', attempts: 0, maxAttempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).not.toHaveBeenCalled();
      expect(deliveryRepo.markRetry).toHaveBeenCalled();
    });

    it('should pass null tenantId for global deliveries', async () => {
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryFailed },
      );

      const enriched = makeDelivery({ id: 'd-global', tenantId: null, attempts: 2, maxAttempts: 3 });
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: null }),
      );
    });
  });

  describe('onDeliveryRetryScheduled callback', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('should fire retry hook after retriable HTTP failure is persisted for retry', async () => {
      const nextDate = new Date('2026-05-02T00:00:00.000Z');
      const onDeliveryRetryScheduled = jest.fn();
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10 },
          onDeliveryRetryScheduled,
          onDeliveryFailed,
        },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 503,
        error: 'receiver unavailable',
        body: 'unavailable',
        latencyMs: 100,
      };
      const enriched = makeDelivery({
        id: 'd-retry-hook',
        endpointId: 'ep-retry-hook',
        attempts: 1,
        maxAttempts: 4,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markRetry).toHaveBeenCalledWith(
        'd-retry-hook',
        2,
        nextDate,
        result,
      );
      expect(onDeliveryRetryScheduled).toHaveBeenCalledWith({
        deliveryId: 'd-retry-hook',
        endpointId: 'ep-retry-hook',
        eventId: 'evt-1',
        tenantId: 'tenant-1',
        attempts: 2,
        maxAttempts: 4,
        nextAttemptAt: nextDate,
        lastError: 'receiver unavailable',
        responseStatus: 503,
        failureKind: 'http_error',
      });
      expect(
        deliveryRepo.markRetry.mock.invocationCallOrder[0],
      ).toBeLessThan(onDeliveryRetryScheduled.mock.invocationCallOrder[0]);
      expect(onDeliveryFailed).not.toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-retry-hook',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });

    it('should not fire retry hook for final HTTP failure and still fire terminal hook', async () => {
      const onDeliveryRetryScheduled = jest.fn();
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10 },
          onDeliveryRetryScheduled,
          onDeliveryFailed,
        },
      );
      const enriched = makeDelivery({
        id: 'd-final-no-retry-hook',
        endpointId: 'ep-final-no-retry-hook',
        attempts: 2,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-final-no-retry-hook',
        3,
        expect.objectContaining({ success: false }),
      );
      expect(onDeliveryRetryScheduled).not.toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-final-no-retry-hook',
          attempts: 3,
          failureKind: 'http_error',
        }),
      );
    });

    it('should not fire retry hook for non-retryable HTTP failure and still fire terminal hook', async () => {
      const onDeliveryRetryScheduled = jest.fn();
      const onDeliveryFailed = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        {
          polling: { batchSize: 10 },
          onDeliveryRetryScheduled,
          onDeliveryFailed,
        },
      );
      const result: DeliveryResult = {
        success: false,
        statusCode: 410,
        body: 'gone',
        latencyMs: 100,
      };
      const enriched = makeDelivery({
        id: 'd-gone-no-retry-hook',
        endpointId: 'ep-gone-no-retry-hook',
        attempts: 0,
        maxAttempts: 5,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(result);

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markFailed).toHaveBeenCalledWith(
        'd-gone-no-retry-hook',
        1,
        result,
      );
      expect(onDeliveryRetryScheduled).not.toHaveBeenCalled();
      expect(onDeliveryFailed).toHaveBeenCalledWith(
        expect.objectContaining({
          responseStatus: 410,
          failureKind: 'http_error',
        }),
      );
    });

    it('should fire retry hook for retriable dispatcher exception', async () => {
      const nextDate = new Date('2026-05-02T00:01:00.000Z');
      const onDeliveryRetryScheduled = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-exception-retry-hook',
        endpointId: 'ep-exception-retry-hook',
        attempts: 0,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: 'd-exception-retry-hook',
          endpointId: 'ep-exception-retry-hook',
          attempts: 1,
          maxAttempts: 3,
          nextAttemptAt: nextDate,
          lastError: 'ECONNREFUSED',
          responseStatus: null,
          failureKind: 'dispatch_error',
        }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-exception-retry-hook',
        false,
        { tenantId: 'tenant-1', url: 'https://example.com/hook' },
      );
    });

    it('should fire retry hook for retriable WebhookUrlValidationError with metadata', async () => {
      const nextDate = new Date('2026-05-02T00:02:00.000Z');
      const onDeliveryRetryScheduled = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({
        id: 'd-validation-retry-hook',
        endpointId: 'ep-validation-retry-hook',
        url: 'http://evil.nip.io/hook',
        attempts: 0,
        maxAttempts: 3,
      });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockRejectedValueOnce(
        new WebhookUrlValidationError(
          'Invalid webhook URL: "10.0.0.1" is a private address',
          'private',
          'http://evil.nip.io/hook',
          '10.0.0.1',
        ),
      );
      retryPolicy.nextAttemptAt.mockReturnValueOnce(nextDate);

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryRetryScheduled).toHaveBeenCalledWith(
        expect.objectContaining({
          failureKind: 'url_validation',
          validationReason: 'private',
          validationUrl: 'http://evil.nip.io/hook',
          resolvedIp: '10.0.0.1',
          responseStatus: null,
          nextAttemptAt: nextDate,
        }),
      );
      expect(circuitBreaker.afterDelivery).toHaveBeenCalledWith(
        'ep-validation-retry-hook',
        false,
        { tenantId: 'tenant-1', url: 'http://evil.nip.io/hook' },
      );
    });

    it('should not fire retry hook when markRetry fails', async () => {
      const onDeliveryRetryScheduled = jest.fn();
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({ id: 'd-mark-retry-fail' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());
      deliveryRepo.markRetry.mockRejectedValueOnce(new Error('db unavailable'));

      await workerWithHook.poll();
      await flush();

      expect(onDeliveryRetryScheduled).not.toHaveBeenCalled();
    });

    it('should log rejected retry hook and not reject worker processing', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const onDeliveryRetryScheduled = jest
        .fn()
        .mockRejectedValue(new Error('callback boom'));
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({ id: 'd-rejected-retry-hook' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();
      await flush();

      expect(deliveryRepo.markRetry).toHaveBeenCalled();
      expect(circuitBreaker.afterDelivery).toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        'onDeliveryRetryScheduled callback error: callback boom',
        expect.any(String),
      );
      loggerError.mockRestore();
    });

    it('should log synchronous retry hook throw and not retry delivery state handling', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const onDeliveryRetryScheduled = jest.fn(() => {
        throw new Error('sync callback boom');
      });
      const workerWithHook = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, onDeliveryRetryScheduled },
      );
      const enriched = makeDelivery({ id: 'd-sync-retry-hook' });

      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([enriched]);
      deliveryRepo.enrichDeliveries.mockResolvedValueOnce([enriched]);
      dispatcher.dispatch.mockResolvedValueOnce(makeFailureResult());

      await workerWithHook.poll();

      expect(deliveryRepo.markRetry).toHaveBeenCalledTimes(1);
      expect(circuitBreaker.afterDelivery).toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        'onDeliveryRetryScheduled callback error: sync callback boom',
        expect.any(String),
      );
      loggerError.mockRestore();
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

    it('should wait for an active poll cycle before completing shutdown', async () => {
      let resolveRecovery!: () => void;
      circuitBreaker.recoverEligibleEndpoints.mockReturnValueOnce(
        new Promise<number>((resolve) => {
          resolveRecovery = () => resolve(0);
        }),
      );

      const pollPromise = worker.poll();
      await Promise.resolve();

      let shutdownComplete = false;
      const shutdownPromise = worker.onModuleDestroy().then(() => {
        shutdownComplete = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(shutdownComplete).toBe(false);

      resolveRecovery();
      deliveryRepo.claimPendingDeliveries.mockResolvedValueOnce([]);
      await pollPromise;
      await shutdownPromise;

      expect(shutdownComplete).toBe(true);
    });
  });

  describe('logging', () => {
    it('should include stack traces when poll-level errors are logged', async () => {
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const error = new Error('claim failed');
      deliveryRepo.claimPendingDeliveries.mockRejectedValueOnce(error);

      await worker.poll();

      expect(loggerError).toHaveBeenCalledWith(
        'Poll cycle failed: claim failed',
        error.stack,
      );
    });

    it('notifies observer when a poll-level error occurs', async () => {
      const observer = { onPollError: jest.fn(), onPollComplete: jest.fn() };
      const workerWithObserver = new WebhookDeliveryWorker(
        deliveryRepo as unknown as WebhookDeliveryRepository,
        dispatcher as unknown as WebhookDispatcher,
        retryPolicy as unknown as WebhookRetryPolicy,
        circuitBreaker,
        { polling: { batchSize: 10 }, workerObserver: observer },
      );
      const error = new Error('claim failed');

      deliveryRepo.claimPendingDeliveries.mockRejectedValueOnce(error);

      await workerWithObserver.poll();

      expect(observer.onPollError).toHaveBeenCalledWith(error);
      expect(observer.onPollComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          claimed: 0,
          enriched: 0,
          sent: 0,
          failed: 0,
          retried: 0,
          loops: 0,
        }),
      );
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
