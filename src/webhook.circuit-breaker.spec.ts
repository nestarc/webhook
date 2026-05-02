import { Logger } from '@nestjs/common';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import { ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED } from './webhook.constants';
import { EndpointRecord } from './interfaces/webhook-endpoint.interface';

function makeEndpointRecord(
  overrides: Partial<EndpointRecord> = {},
): EndpointRecord {
  return {
    id: 'ep-1',
    url: 'https://example.com/hook',
    events: ['order.created'],
    active: true,
    description: null,
    metadata: null,
    tenantId: 'tenant-1',
    consecutiveFailures: 0,
    disabledAt: null,
    disabledReason: null,
    previousSecretExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createMockEndpointRepo() {
  return {
    getEndpoint: jest.fn().mockResolvedValue(makeEndpointRecord()),
    resetFailures: jest.fn().mockResolvedValue(undefined),
    incrementFailures: jest.fn().mockResolvedValue(1),
    disableEndpoint: jest.fn().mockResolvedValue(true),
    recoverEligibleEndpoints: jest.fn().mockResolvedValue(0),
  } as jest.Mocked<Pick<WebhookEndpointRepository, 'getEndpoint' | 'resetFailures' | 'incrementFailures' | 'disableEndpoint' | 'recoverEligibleEndpoints'>>;
}

describe('WebhookCircuitBreaker', () => {
  let cb: WebhookCircuitBreaker;
  let endpointRepo: ReturnType<typeof createMockEndpointRepo>;

  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    endpointRepo = createMockEndpointRepo();
    cb = new WebhookCircuitBreaker(
      endpointRepo as unknown as WebhookEndpointRepository,
      {
        circuitBreaker: {
          failureThreshold: 3,
          cooldownMinutes: 30,
        },
      },
    );
  });

  describe('afterDelivery — success', () => {
    it('should reset failures on success', async () => {
      await cb.afterDelivery('ep-1', true, { tenantId: 'tenant-1', url: 'https://example.com/hook' });

      expect(endpointRepo.resetFailures).toHaveBeenCalledTimes(1);
      expect(endpointRepo.resetFailures).toHaveBeenCalledWith('ep-1');
      expect(endpointRepo.incrementFailures).not.toHaveBeenCalled();
    });
  });

  describe('afterDelivery — failure below threshold', () => {
    it('should increment failures without disabling', async () => {
      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await cb.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });

      expect(endpointRepo.incrementFailures).toHaveBeenCalledTimes(1);
      expect(endpointRepo.incrementFailures).toHaveBeenCalledWith('ep-1');
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });
  });

  describe('afterDelivery — failure at threshold', () => {
    it('should disable endpoint when threshold reached', async () => {
      endpointRepo.incrementFailures.mockResolvedValueOnce(3);

      await cb.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });

      expect(endpointRepo.disableEndpoint).toHaveBeenCalledTimes(1);
      expect(endpointRepo.disableEndpoint).toHaveBeenCalledWith(
        'ep-1',
        ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
      );
    });
  });

  describe('afterDelivery — failure above threshold', () => {
    it('should also disable endpoint when above threshold', async () => {
      endpointRepo.incrementFailures.mockResolvedValueOnce(5);

      await cb.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });

      expect(endpointRepo.disableEndpoint).toHaveBeenCalledTimes(1);
    });
  });

  describe('recoverEligibleEndpoints', () => {
    it('should recover endpoints past cooldown', async () => {
      endpointRepo.recoverEligibleEndpoints.mockResolvedValueOnce(2);

      const count = await cb.recoverEligibleEndpoints();

      expect(count).toBe(2);
      expect(endpointRepo.recoverEligibleEndpoints).toHaveBeenCalledWith(30);
    });

    it('should return 0 when no endpoints to recover', async () => {
      endpointRepo.recoverEligibleEndpoints.mockResolvedValueOnce(0);

      const count = await cb.recoverEligibleEndpoints();

      expect(count).toBe(0);
    });
  });

  describe('onEndpointDegraded callback', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('should not emit degraded event when degradedThreshold is omitted', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should call onEndpointDegraded at exact degraded threshold without disabling', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.getEndpoint).toHaveBeenCalledWith('ep-1');
      expect(onEndpointDegraded).toHaveBeenCalledWith({
        endpointId: 'ep-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
        reason: 'consecutive_failures_degraded',
        consecutiveFailures: 2,
        degradedThreshold: 2,
        failureThreshold: 3,
      });
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should not emit degraded event above degraded threshold', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 5, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should not look up endpoint when degradedThreshold is configured without a degraded hook', async () => {
      const cbWithoutHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await expect(
        cbWithoutHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' }),
      ).resolves.toBeUndefined();
      await flush();

      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should not emit degraded event when degradedThreshold is at or above failureThreshold but still disable at threshold', async () => {
      const onEndpointDegraded = jest.fn();
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 3, cooldownMinutes: 30 },
          onEndpointDegraded,
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.getEndpoint).not.toHaveBeenCalled();
      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).toHaveBeenCalledWith(
        'ep-1',
        ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
      );
      expect(onEndpointDisabled).toHaveBeenCalled();
    });

    it('should not emit degraded event when endpoint is inactive', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);
      endpointRepo.getEndpoint.mockResolvedValueOnce(makeEndpointRecord({ active: false }));

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.getEndpoint).toHaveBeenCalledWith('ep-1');
      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should not emit degraded event when endpoint is missing', async () => {
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);
      endpointRepo.getEndpoint.mockResolvedValueOnce(null);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.getEndpoint).toHaveBeenCalledWith('ep-1');
      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should log endpoint lookup errors and resolve afterDelivery without calling degraded hook', async () => {
      const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const onEndpointDegraded = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);
      endpointRepo.getEndpoint.mockRejectedValueOnce(new Error('lookup boom'));

      await expect(
        cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' }),
      ).resolves.toBeUndefined();
      await flush();

      expect(endpointRepo.getEndpoint).toHaveBeenCalledWith('ep-1');
      expect(onEndpointDegraded).not.toHaveBeenCalled();
      expect(loggerError).toHaveBeenCalledWith(
        'onEndpointDegraded lookup error: lookup boom',
        expect.any(String),
      );
      expect(endpointRepo.disableEndpoint).not.toHaveBeenCalled();
    });

    it('should log rejected degraded hook errors and resolve afterDelivery', async () => {
      const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const onEndpointDegraded = jest.fn().mockRejectedValue(new Error('callback boom'));
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await expect(
        cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' }),
      ).resolves.toBeUndefined();
      await flush();

      expect(loggerError).toHaveBeenCalledWith(
        'onEndpointDegraded callback error: callback boom',
        expect.any(String),
      );
    });

    it('should log synchronous degraded hook errors and resolve afterDelivery', async () => {
      const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      const onEndpointDegraded = jest.fn(() => {
        throw new Error('sync callback boom');
      });
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, degradedThreshold: 2, cooldownMinutes: 30 },
          onEndpointDegraded,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await expect(
        cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' }),
      ).resolves.toBeUndefined();
      await flush();

      expect(loggerError).toHaveBeenCalledWith(
        'onEndpointDegraded callback error: sync callback boom',
        expect.any(String),
      );
    });
  });

  describe('onEndpointDisabled callback', () => {
    const flush = () => new Promise((r) => setImmediate(r));

    it('should call onEndpointDisabled at exact threshold crossing', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(onEndpointDisabled).toHaveBeenCalledWith({
        endpointId: 'ep-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
        reason: ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
        consecutiveFailures: 2,
      });
    });

    it('should not call callback on successful delivery', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      await cbWithHook.afterDelivery('ep-1', true, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(onEndpointDisabled).not.toHaveBeenCalled();
    });

    it('should not call callback when below threshold', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 3, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(1);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(onEndpointDisabled).not.toHaveBeenCalled();
    });

    it('should not call callback above threshold when the endpoint was already inactive', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(4);
      endpointRepo.disableEndpoint.mockResolvedValueOnce(false);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.disableEndpoint).toHaveBeenCalled();
      expect(onEndpointDisabled).not.toHaveBeenCalled();
    });

    it('should call callback above threshold when disable transition succeeds after an earlier disable failure', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);
      endpointRepo.disableEndpoint.mockRejectedValueOnce(new Error('db unavailable'));

      await expect(
        cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' }),
      ).rejects.toThrow('db unavailable');

      endpointRepo.incrementFailures.mockResolvedValueOnce(3);
      endpointRepo.disableEndpoint.mockResolvedValueOnce(true);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(onEndpointDisabled).toHaveBeenCalledTimes(1);
      expect(onEndpointDisabled).toHaveBeenCalledWith({
        endpointId: 'ep-1',
        tenantId: 'tenant-1',
        url: 'https://example.com/hook',
        reason: ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
        consecutiveFailures: 3,
      });
    });

    it('should not call callback when endpoint was already inactive', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);
      endpointRepo.disableEndpoint.mockResolvedValueOnce(false);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(onEndpointDisabled).not.toHaveBeenCalled();
    });

    it('should not propagate callback errors', async () => {
      const onEndpointDisabled = jest.fn().mockRejectedValue(new Error('callback boom'));
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.disableEndpoint).toHaveBeenCalled();
      expect(onEndpointDisabled).toHaveBeenCalled();
    });

    it('should pass null tenantId for global endpoints', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(2);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: null, url: 'https://example.com/hook' });
      await flush();

      expect(onEndpointDisabled).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: null }),
      );
    });
  });

  describe('default options', () => {
    it('should use default threshold and cooldown when not configured', () => {
      const defaultCb = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {},
      );

      // Access private fields via any cast for verification
      expect((defaultCb as any).failureThreshold).toBe(5);
      expect((defaultCb as any).cooldownMinutes).toBe(60);
    });
  });
});
