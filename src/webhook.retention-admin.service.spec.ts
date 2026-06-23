import { WebhookRetentionAdminService } from './webhook.retention-admin.service';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';

describe('WebhookRetentionAdminService', () => {
  it('returns zero counts when retention options are not configured', async () => {
    const repo = {
      purgeExpiredData: jest.fn(),
    };
    const service = new WebhookRetentionAdminService(
      repo as unknown as WebhookDeliveryRepository,
      {},
    );

    await expect(service.purgeExpiredData()).resolves.toEqual({
      eventsPurged: 0,
      deliveriesPurged: 0,
      attemptsPurged: 0,
    });
    expect(repo.purgeExpiredData).not.toHaveBeenCalled();
  });

  it('delegates purge to the repository when retention is configured', async () => {
    const now = new Date('2026-06-23T00:00:00.000Z');
    const repo = {
      purgeExpiredData: jest.fn().mockResolvedValueOnce({
        eventsPurged: 1,
        deliveriesPurged: 2,
        attemptsPurged: 3,
      }),
    };
    const retention = {
      eventPayloadRetentionDays: 30,
      deliveryResponseBodyRetentionDays: 14,
      attemptResponseBodyRetentionDays: 7,
    };
    const service = new WebhookRetentionAdminService(
      repo as unknown as WebhookDeliveryRepository,
      { retention },
    );

    await expect(service.purgeExpiredData(now)).resolves.toEqual({
      eventsPurged: 1,
      deliveriesPurged: 2,
      attemptsPurged: 3,
    });
    expect(repo.purgeExpiredData).toHaveBeenCalledWith(retention, now);
  });

  it('treats zero-day retention values as configured', async () => {
    const repo = {
      purgeExpiredData: jest.fn().mockResolvedValueOnce({
        eventsPurged: 1,
        deliveriesPurged: 1,
        attemptsPurged: 1,
      }),
    };
    const retention = {
      eventPayloadRetentionDays: 0,
      deliveryResponseBodyRetentionDays: 0,
      attemptResponseBodyRetentionDays: 0,
    };
    const service = new WebhookRetentionAdminService(
      repo as unknown as WebhookDeliveryRepository,
      { retention },
    );

    await expect(service.purgeExpiredData()).resolves.toEqual({
      eventsPurged: 1,
      deliveriesPurged: 1,
      attemptsPurged: 1,
    });
    expect(repo.purgeExpiredData).toHaveBeenCalledWith(retention, undefined);
  });

  it('throws a clear error when configured retention lacks repository support', async () => {
    const service = new WebhookRetentionAdminService(
      {} as unknown as WebhookDeliveryRepository,
      { retention: { eventPayloadRetentionDays: 30 } },
    );

    await expect(service.purgeExpiredData()).rejects.toThrow(
      'WebhookDeliveryRepository does not support retention purge',
    );
  });
});
