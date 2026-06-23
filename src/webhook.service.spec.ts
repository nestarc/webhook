import { WebhookService } from './webhook.service';
import { WebhookEvent } from './webhook.event';
import { WebhookEventRepository } from './ports/webhook-event.repository';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import {
  WebhookDeliveryRepository,
} from './ports/webhook-delivery.repository';
import { EndpointRecord } from './interfaces/webhook-endpoint.interface';

class TestEvent extends WebhookEvent {
  static readonly eventType = 'test.created';
  constructor(public readonly testId: string) {
    super();
  }
}

function createMockRepos() {
  const eventRepo = {
    saveEvent: jest.fn(),
    saveEventInTransaction: jest.fn(),
    saveEventOnceInTransaction: jest.fn(),
  };

  const endpointRepo = {
    findMatchingEndpointsInTransaction: jest.fn(),
  };

  const deliveryRepo = {
    runInTransaction: jest.fn(<T,>(cb: (tx: unknown) => Promise<T>) => cb('fake-tx' as unknown)),
    createDeliveriesInTransaction: jest.fn(),
  };

  return { eventRepo, endpointRepo, deliveryRepo };
}

function makeEndpoint(overrides: Partial<EndpointRecord> = {}): EndpointRecord {
  return {
    id: 'ep-1',
    url: 'https://a.com/hook',
    events: ['test.created'],
    active: true,
    description: null,
    metadata: null,
    tenantId: null,
    consecutiveFailures: 0,
    disabledAt: null,
    disabledReason: null,
    previousSecretExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('WebhookService', () => {
  let service: WebhookService;
  let eventRepo: ReturnType<typeof createMockRepos>['eventRepo'];
  let endpointRepo: ReturnType<typeof createMockRepos>['endpointRepo'];
  let deliveryRepo: ReturnType<typeof createMockRepos>['deliveryRepo'];

  beforeEach(() => {
    const mocks = createMockRepos();
    eventRepo = mocks.eventRepo;
    endpointRepo = mocks.endpointRepo;
    deliveryRepo = mocks.deliveryRepo;

    service = new WebhookService(
      eventRepo as unknown as WebhookEventRepository,
      endpointRepo as unknown as WebhookEndpointRepository,
      deliveryRepo as unknown as WebhookDeliveryRepository,
      {},
    );
  });

  describe('send', () => {
    it('should save event and create deliveries within a transaction', async () => {
      const eventId = 'evt-123';
      eventRepo.saveEventInTransaction.mockResolvedValueOnce(eventId);
      endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-1' }),
        makeEndpoint({ id: 'ep-2', events: ['*'] }),
      ]);
      deliveryRepo.createDeliveriesInTransaction.mockResolvedValueOnce(undefined);

      const result = await service.send(new TestEvent('t1'));

      expect(result).toBe(eventId);
      expect(deliveryRepo.runInTransaction).toHaveBeenCalledTimes(1);
      expect(eventRepo.saveEventInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 't1' },
        null,
      );
      expect(endpointRepo.findMatchingEndpointsInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        undefined,
      );
      expect(deliveryRepo.createDeliveriesInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        eventId,
        ['ep-1', 'ep-2'],
        5,
      );
    });

    it('should return eventId even when no matching endpoints', async () => {
      const eventId = 'evt-456';
      eventRepo.saveEventInTransaction.mockResolvedValueOnce(eventId);
      endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([]);

      const result = await service.send(new TestEvent('t2'));

      expect(result).toBe(eventId);
      expect(deliveryRepo.createDeliveriesInTransaction).not.toHaveBeenCalled();
    });

    it('should rollback when delivery creation fails', async () => {
      eventRepo.saveEventInTransaction.mockResolvedValueOnce('evt-err');
      endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-1' }),
      ]);
      deliveryRepo.createDeliveriesInTransaction.mockRejectedValueOnce(
        new Error('DB constraint violation'),
      );

      await expect(service.send(new TestEvent('t-fail'))).rejects.toThrow(
        'DB constraint violation',
      );
    });

    it('should use maxRetries from options', async () => {
      const mocks = createMockRepos();
      const customService = new WebhookService(
        mocks.eventRepo as unknown as WebhookEventRepository,
        mocks.endpointRepo as unknown as WebhookEndpointRepository,
        mocks.deliveryRepo as unknown as WebhookDeliveryRepository,
        { delivery: { maxRetries: 10 } },
      );

      mocks.eventRepo.saveEventInTransaction.mockResolvedValueOnce('evt-custom');
      mocks.endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-1' }),
      ]);
      mocks.deliveryRepo.createDeliveriesInTransaction.mockResolvedValueOnce(undefined);

      await customService.send(new TestEvent('t-custom'));

      expect(mocks.deliveryRepo.createDeliveriesInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'evt-custom',
        ['ep-1'],
        10,
      );
    });

    it('should save idempotent events once and enqueue deliveries only for newly created events', async () => {
      const eventId = 'evt-idempotent';
      eventRepo.saveEventOnceInTransaction.mockResolvedValueOnce({
        id: eventId,
        created: true,
      });
      endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-1' }),
      ]);
      deliveryRepo.createDeliveriesInTransaction.mockResolvedValueOnce(undefined);

      const result = await (service as any).send(new TestEvent('t-idem'), {
        idempotencyKey: 'order-1:create',
        correlationId: 'req-1',
      });

      expect(result).toBe(eventId);
      expect(eventRepo.saveEventInTransaction).not.toHaveBeenCalled();
      expect(eventRepo.saveEventOnceInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 't-idem' },
        null,
        {
          idempotencyKey: 'order-1:create',
          correlationId: 'req-1',
        },
      );
      expect(deliveryRepo.createDeliveriesInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        eventId,
        ['ep-1'],
        5,
      );
    });

    it('should return the existing event ID and skip deliveries for duplicate idempotent sends', async () => {
      eventRepo.saveEventOnceInTransaction.mockResolvedValueOnce({
        id: 'evt-existing',
        created: false,
      });

      const result = await (service as any).send(new TestEvent('t-idem'), {
        idempotencyKey: 'order-1:create',
      });

      expect(result).toBe('evt-existing');
      expect(endpointRepo.findMatchingEndpointsInTransaction).not.toHaveBeenCalled();
      expect(deliveryRepo.createDeliveriesInTransaction).not.toHaveBeenCalled();
    });

    it('should reject idempotent sends when the event repository does not support them', async () => {
      delete (eventRepo as any).saveEventOnceInTransaction;

      await expect(
        (service as any).send(new TestEvent('t-idem'), {
          idempotencyKey: 'order-1:create',
        }),
      ).rejects.toThrow(
        'WebhookEventRepository does not support idempotent event persistence',
      );
    });

    it('should sanitize payload before persistence and matching endpoint lookup', async () => {
      const mocks = createMockRepos();
      const sanitizePayload = jest.fn().mockReturnValue({
        testId: 'redacted',
      });
      const customService = new WebhookService(
        mocks.eventRepo as unknown as WebhookEventRepository,
        mocks.endpointRepo as unknown as WebhookEndpointRepository,
        mocks.deliveryRepo as unknown as WebhookDeliveryRepository,
        {
          redaction: {
            sanitizePayload,
          },
        } as any,
      );
      mocks.eventRepo.saveEventInTransaction.mockResolvedValueOnce('evt-redacted');
      mocks.endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-1' }),
      ]);

      await customService.send(new TestEvent('sensitive'));

      expect(sanitizePayload).toHaveBeenCalledWith(
        { testId: 'sensitive' },
        { eventType: 'test.created', tenantId: null },
      );
      expect(mocks.eventRepo.saveEventInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 'redacted' },
        null,
      );
    });
  });

  describe('sendToTenant', () => {
    it('should include tenantId in event save and endpoint lookup', async () => {
      const eventId = 'evt-789';
      eventRepo.saveEventInTransaction.mockResolvedValueOnce(eventId);
      endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-t1', tenantId: 'tenant-1' }),
      ]);
      deliveryRepo.createDeliveriesInTransaction.mockResolvedValueOnce(undefined);

      await service.sendToTenant('tenant-1', new TestEvent('t3'));

      expect(eventRepo.saveEventInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 't3' },
        'tenant-1',
      );
      expect(endpointRepo.findMatchingEndpointsInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        'tenant-1',
      );
    });

    it('should not include tenantId filter in send() without tenant', async () => {
      eventRepo.saveEventInTransaction.mockResolvedValueOnce('evt-no-tenant');
      endpointRepo.findMatchingEndpointsInTransaction.mockResolvedValueOnce([]);

      await service.send(new TestEvent('t4'));

      // tenantId should be passed as null for event, undefined for endpoint lookup
      expect(eventRepo.saveEventInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 't4' },
        null,
      );
      expect(endpointRepo.findMatchingEndpointsInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        undefined,
      );
    });
  });

  describe('sendToEndpoints', () => {
    it('should create deliveries only for specified endpoint IDs', async () => {
      const eventId = 'evt-targeted';
      eventRepo.saveEventInTransaction.mockResolvedValueOnce(eventId);
      deliveryRepo.createDeliveriesInTransaction.mockResolvedValueOnce(undefined);

      const result = await service.sendToEndpoints(
        ['ep-a', 'ep-b'],
        new TestEvent('t5'),
        'tenant-1',
      );

      expect(result).toBe(eventId);
      expect(eventRepo.saveEventInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 't5' },
        'tenant-1',
      );
      // Should NOT call findMatchingEndpointsInTransaction
      expect(endpointRepo.findMatchingEndpointsInTransaction).not.toHaveBeenCalled();
      expect(deliveryRepo.createDeliveriesInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        eventId,
        ['ep-a', 'ep-b'],
        5,
      );
    });

    it('should save event without deliveries when endpointIds is empty', async () => {
      const eventId = 'evt-empty';
      eventRepo.saveEventInTransaction.mockResolvedValueOnce(eventId);

      const result = await service.sendToEndpoints([], new TestEvent('t6'));

      expect(result).toBe(eventId);
      expect(deliveryRepo.createDeliveriesInTransaction).not.toHaveBeenCalled();
    });

    it('should work without tenantId', async () => {
      const eventId = 'evt-no-tenant';
      eventRepo.saveEventInTransaction.mockResolvedValueOnce(eventId);
      deliveryRepo.createDeliveriesInTransaction.mockResolvedValueOnce(undefined);

      await service.sendToEndpoints(['ep-x'], new TestEvent('t7'));

      expect(eventRepo.saveEventInTransaction).toHaveBeenCalledWith(
        'fake-tx',
        'test.created',
        { testId: 't7' },
        null,
      );
    });
  });
});
