import { WebhookDeliveryAdminService } from './webhook.delivery-admin.service';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';

function createDeliveryRepo() {
  return {
    getDeliveryLogs: jest.fn(),
    getDeliveryAttempts: jest.fn(),
    retryDelivery: jest.fn(),
  };
}

describe('WebhookDeliveryAdminService', () => {
  it('keeps single delivery retry backward-compatible while accepting options', async () => {
    const repo = createDeliveryRepo();
    repo.retryDelivery.mockResolvedValueOnce(true);
    const service = new WebhookDeliveryAdminService(
      repo as unknown as WebhookDeliveryRepository,
    );

    await expect(
      service.retryDelivery('delivery-1', { reason: 'customer requested replay' }),
    ).resolves.toBe(true);

    expect(repo.retryDelivery).toHaveBeenCalledWith('delivery-1', {
      reason: 'customer requested replay',
    });
  });

  it('delegates bulk failed delivery retry when the repository supports it', async () => {
    const repo = {
      ...createDeliveryRepo(),
      retryFailedDeliveries: jest.fn().mockResolvedValueOnce({
        matched: 3,
        retried: 2,
        skipped: 1,
      }),
    };
    const service = new WebhookDeliveryAdminService(
      repo as unknown as WebhookDeliveryRepository,
    );

    await expect(
      service.retryFailedDeliveries(
        { endpointId: 'endpoint-1', eventType: 'order.created', limit: 50 },
        { reason: 'incident recovery' },
      ),
    ).resolves.toEqual({ matched: 3, retried: 2, skipped: 1 });

    expect(repo.retryFailedDeliveries).toHaveBeenCalledWith(
      { endpointId: 'endpoint-1', eventType: 'order.created', limit: 50 },
      { reason: 'incident recovery' },
    );
  });

  it('throws a clear error when bulk retry is unsupported by the repository', async () => {
    const service = new WebhookDeliveryAdminService(
      createDeliveryRepo() as unknown as WebhookDeliveryRepository,
    );

    await expect(
      service.retryFailedDeliveries({ endpointId: 'endpoint-1' }),
    ).rejects.toThrow(
      'WebhookDeliveryRepository does not support bulk failed delivery retry',
    );
  });

  it('delegates event replay when the repository supports it', async () => {
    const repo = {
      ...createDeliveryRepo(),
      replayEvent: jest.fn().mockResolvedValueOnce({
        eventId: 'event-1',
        deliveriesCreated: 2,
        endpointIds: ['endpoint-1', 'endpoint-2'],
      }),
    };
    const service = new WebhookDeliveryAdminService(
      repo as unknown as WebhookDeliveryRepository,
    );

    await expect(
      service.replayEvent('event-1', {
        tenantId: 'tenant_123',
        reason: 'customer support replay',
      }),
    ).resolves.toEqual({
      eventId: 'event-1',
      deliveriesCreated: 2,
      endpointIds: ['endpoint-1', 'endpoint-2'],
    });

    expect(repo.replayEvent).toHaveBeenCalledWith('event-1', {
      tenantId: 'tenant_123',
      reason: 'customer support replay',
    });
  });

  it('throws a clear error when replay is unsupported by the repository', async () => {
    const service = new WebhookDeliveryAdminService(
      createDeliveryRepo() as unknown as WebhookDeliveryRepository,
    );

    await expect(service.replayEvent('event-1')).rejects.toThrow(
      'WebhookDeliveryRepository does not support event replay',
    );
  });
});
