import { WebhookAdminService } from './webhook.admin.service';
import { WebhookSigner } from './webhook.signer';

function createMockPrisma() {
  return {
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    $executeRaw: jest.fn(),
  };
}

describe('WebhookAdminService', () => {
  let admin: WebhookAdminService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let signer: WebhookSigner;

  beforeEach(() => {
    prisma = createMockPrisma();
    signer = new WebhookSigner();
    admin = new WebhookAdminService({ prisma }, signer);
  });

  describe('createEndpoint', () => {
    it('should create endpoint with auto-generated secret', async () => {
      const endpoint = {
        id: 'ep-1',
        url: 'https://example.com/hook',
        secret: 'generated-secret',
        events: ['order.created'],
        active: true,
      };
      prisma.$queryRaw.mockResolvedValueOnce([endpoint]);

      const result = await admin.createEndpoint({
        url: 'https://example.com/hook',
        events: ['order.created'],
        secret: 'auto',
      });

      expect(result.id).toBe('ep-1');
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should create endpoint with provided secret', async () => {
      const endpoint = {
        id: 'ep-2',
        url: 'https://example.com/hook',
        secret: 'my-custom-secret',
        events: ['*'],
        active: true,
      };
      prisma.$queryRaw.mockResolvedValueOnce([endpoint]);

      const result = await admin.createEndpoint({
        url: 'https://example.com/hook',
        events: ['*'],
        secret: 'my-custom-secret',
      });

      expect(result.secret).toBe('my-custom-secret');
    });
  });

  describe('listEndpoints', () => {
    it('should list all endpoints', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([
        { id: 'ep-1' },
        { id: 'ep-2' },
      ]);

      const result = await admin.listEndpoints();

      expect(result).toHaveLength(2);
    });

    it('should filter by tenantId', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'ep-t1' }]);

      const result = await admin.listEndpoints('tenant-1');

      expect(result).toHaveLength(1);
    });
  });

  describe('getEndpoint', () => {
    it('should return endpoint by id', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([{ id: 'ep-1', url: 'https://example.com' }]);

      const result = await admin.getEndpoint('ep-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('ep-1');
    });

    it('should return null for non-existent endpoint', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      const result = await admin.getEndpoint('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('updateEndpoint', () => {
    it('should update endpoint fields', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'ep-1', url: 'https://new-url.com' },
      ]);

      const result = await admin.updateEndpoint('ep-1', {
        url: 'https://new-url.com',
      });

      expect(result).not.toBeNull();
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    });

    it('should return null when endpoint not found', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      const result = await admin.updateEndpoint('non-existent', {
        url: 'https://new-url.com',
      });

      expect(result).toBeNull();
    });
  });

  describe('deleteEndpoint', () => {
    it('should return true on successful delete', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const result = await admin.deleteEndpoint('ep-1');

      expect(result).toBe(true);
    });

    it('should return false when endpoint not found', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(0);

      const result = await admin.deleteEndpoint('non-existent');

      expect(result).toBe(false);
    });
  });

  describe('retryDelivery', () => {
    it('should reset FAILED delivery to PENDING', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const result = await admin.retryDelivery('del-1');

      expect(result).toBe(true);
    });

    it('should return false for non-FAILED delivery', async () => {
      prisma.$executeRaw.mockResolvedValueOnce(0);

      const result = await admin.retryDelivery('del-2');

      expect(result).toBe(false);
    });
  });

  describe('sendTestEvent', () => {
    it('should create test event and delivery for existing endpoint', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: 'ep-1', url: 'https://example.com', tenantId: null }])
        .mockResolvedValueOnce([{ id: 'evt-test' }]);
      prisma.$executeRaw.mockResolvedValueOnce(1);

      const eventId = await admin.sendTestEvent('ep-1');

      expect(eventId).toBe('evt-test');
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    });

    it('should return null for non-existent endpoint', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);

      const result = await admin.sendTestEvent('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('getDeliveryLogs', () => {
    it('should return delivery logs for endpoint', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'del-1', status: 'SENT' },
        { id: 'del-2', status: 'FAILED' },
      ]);

      const result = await admin.getDeliveryLogs('ep-1');

      expect(result).toHaveLength(2);
    });

    it('should support filtering by status', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'del-2', status: 'FAILED' },
      ]);

      const result = await admin.getDeliveryLogs('ep-1', { status: 'FAILED' });

      expect(result).toHaveLength(1);
      expect(prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    });
  });
});
