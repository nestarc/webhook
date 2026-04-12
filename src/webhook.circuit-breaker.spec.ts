import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';

function createMockEndpointRepo() {
  return {
    resetFailures: jest.fn().mockResolvedValue(undefined),
    incrementFailures: jest.fn().mockResolvedValue(1),
    disableEndpoint: jest.fn().mockResolvedValue(undefined),
    recoverEligibleEndpoints: jest.fn().mockResolvedValue(0),
  } as jest.Mocked<Pick<WebhookEndpointRepository, 'resetFailures' | 'incrementFailures' | 'disableEndpoint' | 'recoverEligibleEndpoints'>>;
}

describe('WebhookCircuitBreaker', () => {
  let cb: WebhookCircuitBreaker;
  let endpointRepo: ReturnType<typeof createMockEndpointRepo>;

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
        'consecutive_failures_exceeded',
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
        reason: 'consecutive_failures_exceeded',
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

    it('should not call callback when above threshold (prevents duplicates)', async () => {
      const onEndpointDisabled = jest.fn();
      const cbWithHook = new WebhookCircuitBreaker(
        endpointRepo as unknown as WebhookEndpointRepository,
        {
          circuitBreaker: { failureThreshold: 2, cooldownMinutes: 30 },
          onEndpointDisabled,
        },
      );

      endpointRepo.incrementFailures.mockResolvedValueOnce(4);

      await cbWithHook.afterDelivery('ep-1', false, { tenantId: 'tenant-1', url: 'https://example.com/hook' });
      await flush();

      expect(endpointRepo.disableEndpoint).toHaveBeenCalled();
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
