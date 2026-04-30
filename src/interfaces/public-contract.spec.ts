import type {
  DeliveryAttemptRecord,
  DeliveryRecord,
} from './webhook-delivery.interface';
import type { EndpointRecord } from './webhook-endpoint.interface';
import type {
  WebhookModuleAsyncOptions,
  WebhookModuleOptions,
} from './webhook-options.interface';
import type {
  ClaimedDelivery,
  PendingDelivery,
  WebhookTransaction,
} from '../ports/webhook-delivery.repository';
import { DEFAULT_BACKOFF_SCHEDULE } from '../webhook.constants';

describe('public interface contracts', () => {
  it('keeps runtime-only shapes reflected in exported types', () => {
    // @ts-expect-error Attempt logs are never persisted with SENDING status.
    const attemptStatus: DeliveryAttemptRecord['status'] = 'SENDING';

    const deliveryBase = {
      id: 'del-1',
      eventId: 'evt-1',
      endpointId: 'ep-1',
      status: 'SENT',
      attempts: 1,
      maxAttempts: 3,
      nextAttemptAt: null,
      lastAttemptAt: new Date(),
      completedAt: new Date(),
      responseStatus: 200,
      responseBody: 'OK',
      latencyMs: 25,
      lastError: null,
    } satisfies Omit<DeliveryRecord, 'destinationUrl' | 'tenantId'>;

    // @ts-expect-error Delivery logs always include the destination URL.
    const deliveryWithoutDestinationUrl: DeliveryRecord = {
      ...deliveryBase,
      tenantId: null,
    };

    // @ts-expect-error Delivery logs always include the tenant ID, null for global endpoints.
    const deliveryWithoutTenantId: DeliveryRecord = {
      ...deliveryBase,
      destinationUrl: 'https://example.com/hook',
    };

    const endpointBase = {
      id: 'ep-1',
      url: 'https://example.com/hook',
      events: ['order.created'],
      active: true,
      description: null,
      metadata: null,
      tenantId: null,
      consecutiveFailures: 0,
      disabledAt: null,
      disabledReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // @ts-expect-error Endpoint records always include the rotation expiry field.
    const endpointWithoutRotationExpiry: EndpointRecord = endpointBase;

    const moduleOptions: WebhookModuleOptions = { prisma: {} };
    if (moduleOptions.prisma) {
      // @ts-expect-error Prisma is unknown on the public options surface until narrowed.
      moduleOptions.prisma.$queryRaw;
    }

    // @ts-expect-error Nest inject tokens cannot be arbitrary numbers.
    const asyncOptions: WebhookModuleAsyncOptions = { inject: [123] };

    // @ts-expect-error WebhookTransaction is an opaque token created by repository adapters.
    const arbitraryTransaction: WebhookTransaction = {};

    if (false) {
      // @ts-expect-error Default backoff schedule is public read-only configuration data.
      DEFAULT_BACKOFF_SCHEDULE.push(1);
    }

    const claimedDelivery: ClaimedDelivery = {
      id: 'del-1',
      eventId: 'evt-1',
      endpointId: 'ep-1',
      attempts: 0,
      maxAttempts: 3,
    };

    const pendingDelivery: PendingDelivery = {
      ...claimedDelivery,
      tenantId: null,
      url: 'https://example.com/hook',
      secret: 'secret',
      additionalSecrets: [],
      eventType: 'order.created',
      payload: { orderId: 'ord-1' },
    };

    // @ts-expect-error PendingDelivery is a domain shape, not a SQL row.
    pendingDelivery.event_id;

    // @ts-expect-error additionalSecrets is always present; use an empty array when no overlap secret exists.
    const pendingWithoutAdditionalSecrets: PendingDelivery = {
      ...claimedDelivery,
      tenantId: null,
      url: 'https://example.com/hook',
      secret: 'secret',
      eventType: 'order.created',
      payload: {},
    };

    expect({
      attemptStatus,
      deliveryWithoutDestinationUrl,
      deliveryWithoutTenantId,
      endpointWithoutRotationExpiry,
      asyncOptions,
      arbitraryTransaction,
      pendingDelivery,
      pendingWithoutAdditionalSecrets,
    }).toBeDefined();
    expect(Object.isFrozen(DEFAULT_BACKOFF_SCHEDULE)).toBe(true);
  });
});
