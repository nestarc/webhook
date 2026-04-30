import { WebhookAdminService } from './webhook.admin.service';
import { WebhookEndpointAdminService } from './webhook.endpoint-admin.service';
import { WebhookDeliveryAdminService } from './webhook.delivery-admin.service';
import { EndpointRecord } from './interfaces/webhook-endpoint.interface';
import {
  DeliveryAttemptRecord,
  DeliveryRecord,
} from './interfaces/webhook-delivery.interface';

function makeEndpoint(overrides: Partial<EndpointRecord> = {}): EndpointRecord {
  return {
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
    previousSecretExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeDeliveryRecord(overrides: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    id: 'del-1',
    eventId: 'evt-1',
    endpointId: 'ep-1',
    destinationUrl: 'https://example.com/hook',
    tenantId: null,
    status: 'SENT',
    attempts: 1,
    maxAttempts: 5,
    nextAttemptAt: null,
    lastAttemptAt: new Date(),
    completedAt: new Date(),
    responseStatus: 200,
    responseBody: 'OK',
    latencyMs: 50,
    lastError: null,
    ...overrides,
  };
}

function createMockEndpointAdmin() {
  return {
    createEndpoint: jest.fn(),
    listEndpoints: jest.fn(),
    getEndpoint: jest.fn(),
    updateEndpoint: jest.fn(),
    rotateSecret: jest.fn(),
    deleteEndpoint: jest.fn(),
    sendTestEvent: jest.fn(),
  } as jest.Mocked<Pick<
    WebhookEndpointAdminService,
    | 'createEndpoint'
    | 'listEndpoints'
    | 'getEndpoint'
    | 'updateEndpoint'
    | 'rotateSecret'
    | 'deleteEndpoint'
    | 'sendTestEvent'
  >>;
}

function createMockDeliveryAdmin() {
  return {
    getDeliveryLogs: jest.fn(),
    getDeliveryAttempts: jest.fn(),
    retryDelivery: jest.fn(),
  } as jest.Mocked<
    Pick<
      WebhookDeliveryAdminService,
      'getDeliveryLogs' | 'getDeliveryAttempts' | 'retryDelivery'
    >
  >;
}

describe('WebhookAdminService', () => {
  let admin: WebhookAdminService;
  let endpointAdmin: ReturnType<typeof createMockEndpointAdmin>;
  let deliveryAdmin: ReturnType<typeof createMockDeliveryAdmin>;

  beforeEach(() => {
    endpointAdmin = createMockEndpointAdmin();
    deliveryAdmin = createMockDeliveryAdmin();
    admin = new WebhookAdminService(
      endpointAdmin as unknown as WebhookEndpointAdminService,
      deliveryAdmin as unknown as WebhookDeliveryAdminService,
    );
  });

  describe('createEndpoint', () => {
    it('should delegate to endpointAdmin.createEndpoint', async () => {
      const endpoint = { ...makeEndpoint(), secret: 'generated-secret' };
      endpointAdmin.createEndpoint.mockResolvedValueOnce(endpoint);

      const result = await admin.createEndpoint({
        url: 'https://example.com/hook',
        events: ['order.created'],
        secret: 'auto',
      });

      expect(result.id).toBe('ep-1');
      expect(endpointAdmin.createEndpoint).toHaveBeenCalledTimes(1);
      expect(endpointAdmin.createEndpoint).toHaveBeenCalledWith({
        url: 'https://example.com/hook',
        events: ['order.created'],
        secret: 'auto',
      });
    });
  });

  describe('listEndpoints', () => {
    it('should delegate to endpointAdmin.listEndpoints', async () => {
      endpointAdmin.listEndpoints.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-1' }),
        makeEndpoint({ id: 'ep-2' }),
      ]);

      const result = await admin.listEndpoints();

      expect(result).toHaveLength(2);
      expect(endpointAdmin.listEndpoints).toHaveBeenCalledWith(undefined);
    });

    it('should pass tenantId filter to delegate', async () => {
      endpointAdmin.listEndpoints.mockResolvedValueOnce([
        makeEndpoint({ id: 'ep-t1', tenantId: 'tenant-1' }),
      ]);

      const result = await admin.listEndpoints('tenant-1');

      expect(result).toHaveLength(1);
      expect(endpointAdmin.listEndpoints).toHaveBeenCalledWith('tenant-1');
    });
  });

  describe('getEndpoint', () => {
    it('should delegate to endpointAdmin.getEndpoint', async () => {
      endpointAdmin.getEndpoint.mockResolvedValueOnce(makeEndpoint());

      const result = await admin.getEndpoint('ep-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('ep-1');
      expect(endpointAdmin.getEndpoint).toHaveBeenCalledWith('ep-1');
    });

    it('should return null for non-existent endpoint', async () => {
      endpointAdmin.getEndpoint.mockResolvedValueOnce(null);

      const result = await admin.getEndpoint('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('updateEndpoint', () => {
    it('should delegate to endpointAdmin.updateEndpoint', async () => {
      const updated = makeEndpoint({ url: 'https://new.com' });
      endpointAdmin.updateEndpoint.mockResolvedValueOnce(updated);

      const result = await admin.updateEndpoint('ep-1', {
        url: 'https://new.com',
      });

      expect(result).not.toBeNull();
      expect(endpointAdmin.updateEndpoint).toHaveBeenCalledWith('ep-1', {
        url: 'https://new.com',
      });
    });

    it('should return null when endpoint not found', async () => {
      endpointAdmin.updateEndpoint.mockResolvedValueOnce(null);

      const result = await admin.updateEndpoint('non-existent', {
        url: 'https://new-url.com',
      });

      expect(result).toBeNull();
    });
  });

  describe('deleteEndpoint', () => {
    it('should delegate to endpointAdmin.deleteEndpoint', async () => {
      endpointAdmin.deleteEndpoint.mockResolvedValueOnce(true);

      const result = await admin.deleteEndpoint('ep-1');

      expect(result).toBe(true);
      expect(endpointAdmin.deleteEndpoint).toHaveBeenCalledWith('ep-1');
    });

    it('should return false when endpoint not found', async () => {
      endpointAdmin.deleteEndpoint.mockResolvedValueOnce(false);

      const result = await admin.deleteEndpoint('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('rotateSecret', () => {
    it('should delegate to endpointAdmin.rotateSecret', async () => {
      const secret = Buffer.from('new-secret-for-rotation').toString('base64');
      const previousSecretExpiresAt = new Date(Date.now() + 60_000);
      const rotated = { ...makeEndpoint({ previousSecretExpiresAt }), secret };
      endpointAdmin.rotateSecret.mockResolvedValueOnce(rotated);

      const result = await admin.rotateSecret('ep-1', {
        secret,
        previousSecretExpiresAt,
      });

      expect(result).toBe(rotated);
      expect(endpointAdmin.rotateSecret).toHaveBeenCalledWith('ep-1', {
        secret,
        previousSecretExpiresAt,
      });
    });
  });

  describe('getDeliveryLogs', () => {
    it('should delegate to deliveryAdmin.getDeliveryLogs', async () => {
      deliveryAdmin.getDeliveryLogs.mockResolvedValueOnce([
        makeDeliveryRecord({ id: 'del-1' }),
        makeDeliveryRecord({ id: 'del-2' }),
      ]);

      const result = await admin.getDeliveryLogs('ep-1');

      expect(result).toHaveLength(2);
      expect(deliveryAdmin.getDeliveryLogs).toHaveBeenCalledWith('ep-1', undefined);
    });

    it('should pass filters to delegate', async () => {
      const filters = { status: 'FAILED' as const, limit: 10, offset: 5 };
      deliveryAdmin.getDeliveryLogs.mockResolvedValueOnce([
        makeDeliveryRecord({ id: 'del-2', status: 'FAILED' }),
      ]);

      const result = await admin.getDeliveryLogs('ep-1', filters);

      expect(result).toHaveLength(1);
      expect(deliveryAdmin.getDeliveryLogs).toHaveBeenCalledWith('ep-1', filters);
    });
  });

  describe('retryDelivery', () => {
    it('should delegate to deliveryAdmin.retryDelivery', async () => {
      deliveryAdmin.retryDelivery.mockResolvedValueOnce(true);

      const result = await admin.retryDelivery('del-1');

      expect(result).toBe(true);
      expect(deliveryAdmin.retryDelivery).toHaveBeenCalledWith('del-1');
    });

    it('should return false for non-FAILED delivery', async () => {
      deliveryAdmin.retryDelivery.mockResolvedValueOnce(false);

      const result = await admin.retryDelivery('del-2');

      expect(result).toBe(false);
    });
  });

  describe('getDeliveryAttempts', () => {
    it('should delegate to deliveryAdmin.getDeliveryAttempts', async () => {
      const attempts: DeliveryAttemptRecord[] = [
        {
          id: 'attempt-1',
          deliveryId: 'del-1',
          attemptNumber: 1,
          status: 'FAILED',
          responseStatus: 500,
          responseBody: 'boom',
          responseBodyTruncated: false,
          latencyMs: 120,
          lastError: 'boom',
          createdAt: new Date(),
        },
      ];
      deliveryAdmin.getDeliveryAttempts.mockResolvedValueOnce(attempts);

      const result = await admin.getDeliveryAttempts('del-1');

      expect(result).toEqual(attempts);
      expect(deliveryAdmin.getDeliveryAttempts).toHaveBeenCalledWith('del-1');
    });
  });

  describe('sendTestEvent', () => {
    it('should delegate to endpointAdmin.sendTestEvent', async () => {
      endpointAdmin.sendTestEvent.mockResolvedValueOnce('evt-test');

      const eventId = await admin.sendTestEvent('ep-1');

      expect(eventId).toBe('evt-test');
      expect(endpointAdmin.sendTestEvent).toHaveBeenCalledWith('ep-1');
    });

    it('should return null for non-existent endpoint', async () => {
      endpointAdmin.sendTestEvent.mockResolvedValueOnce(null);

      const result = await admin.sendTestEvent('non-existent');

      expect(result).toBeNull();
    });
  });
});
