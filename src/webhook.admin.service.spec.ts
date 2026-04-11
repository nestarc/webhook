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

    it('should create endpoint with provided valid base64 secret', async () => {
      const validSecret = Buffer.from('a'.repeat(32)).toString('base64');
      const endpoint = {
        id: 'ep-2',
        url: 'https://example.com/hook',
        secret: validSecret,
        events: ['*'],
        active: true,
      };
      prisma.$queryRaw.mockResolvedValueOnce([endpoint]);

      const result = await admin.createEndpoint({
        url: 'https://example.com/hook',
        events: ['*'],
        secret: validSecret,
      });

      expect(result.secret).toBe(validSecret);
    });

    it('should reject invalid base64 secret', async () => {
      await expect(
        admin.createEndpoint({
          url: 'https://example.com/hook',
          events: ['*'],
          secret: '!!!not-base64!!!',
        }),
      ).rejects.toThrow('Invalid secret');
    });

    it('should reject secret that decodes to less than 16 bytes', async () => {
      const shortSecret = Buffer.from('short').toString('base64'); // 5 bytes
      await expect(
        admin.createEndpoint({
          url: 'https://example.com/hook',
          events: ['*'],
          secret: shortSecret,
        }),
      ).rejects.toThrow('at least 16 bytes');
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
    it('should build SET clause for all fields with correct parameter order', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'ep-1' }]);

      await admin.updateEndpoint('ep-1', {
        url: 'https://new.com',
        events: ['order.*'],
        description: 'updated',
        metadata: { key: 'val' },
        active: false,
      });

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      // 5 SET fields + endpoint ID = 6 params
      expect(params).toHaveLength(6);
      expect(sql).toContain('url = $1');
      expect(sql).toContain('events = $2');
      expect(sql).toContain('description = $3');
      expect(sql).toContain('metadata = $4');
      expect(sql).toContain('active = $5');
      expect(sql).toContain('WHERE id = $6::uuid');

      // Verify param values and order
      expect(params[0]).toBe('https://new.com');
      expect(params[1]).toEqual(['order.*']);
      expect(params[2]).toBe('updated');
      expect(params[3]).toBe('{"key":"val"}');
      expect(params[4]).toBe(false);
      expect(params[5]).toBe('ep-1');
    });

    it('should handle single field (active) update with correct indices', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'ep-1' }]);

      await admin.updateEndpoint('ep-1', { active: false });

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('active = $1');
      expect(sql).toContain('WHERE id = $2::uuid');
      expect(params).toEqual([false, 'ep-1']);
    });

    it('should pass metadata as JSON string parameter', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([{ id: 'ep-1' }]);

      await admin.updateEndpoint('ep-1', { metadata: { nested: { a: 1 } } });

      const params = prisma.$queryRawUnsafe.mock.calls[0].slice(1);
      expect(params[0]).toBe('{"nested":{"a":1}}');
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
    it('should use default limit=50 and offset=0 when no filters', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      await admin.getDeliveryLogs('ep-1');

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('LIMIT $2');
      expect(sql).toContain('OFFSET $3');
      expect(params[0]).toBe('ep-1');
      expect(params[1]).toBe(50);  // default limit
      expect(params[2]).toBe(0);   // default offset
    });

    it('should build WHERE clause with all filter combinations', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([]);

      const since = new Date('2026-01-01');
      const until = new Date('2026-12-31');

      await admin.getDeliveryLogs('ep-1', {
        status: 'FAILED',
        eventType: 'order.created',
        since,
        until,
        limit: 10,
        offset: 5,
      });

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];

      // 4 WHERE conditions + limit + offset = 6 params (+ endpoint_id = 7 total)
      expect(sql).toContain('d.endpoint_id = $1');
      expect(sql).toContain('d.status = $2');
      expect(sql).toContain('ev.event_type = $3');
      expect(sql).toContain('d.last_attempt_at >= $4');
      expect(sql).toContain('d.last_attempt_at <= $5');
      expect(sql).toContain('LIMIT $6');
      expect(sql).toContain('OFFSET $7');

      expect(params[0]).toBe('ep-1');
      expect(params[1]).toBe('FAILED');
      expect(params[2]).toBe('order.created');
      expect(params[3]).toBe(since);
      expect(params[4]).toBe(until);
      expect(params[5]).toBe(10);
      expect(params[6]).toBe(5);
    });

    it('should support filtering by status only', async () => {
      prisma.$queryRawUnsafe.mockResolvedValueOnce([
        { id: 'del-2', status: 'FAILED' },
      ]);

      await admin.getDeliveryLogs('ep-1', { status: 'FAILED' });

      const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
      expect(sql).toContain('d.status = $2');
      expect(params[1]).toBe('FAILED');
    });
  });
});
