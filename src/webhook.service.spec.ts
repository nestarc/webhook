import { WebhookService } from './webhook.service';
import { WebhookEvent } from './webhook.event';

class TestEvent extends WebhookEvent {
  static readonly eventType = 'test.created';
  constructor(public readonly testId: string) {
    super();
  }
}

function createMockPrisma() {
  return {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  };
}

describe('WebhookService', () => {
  let service: WebhookService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new WebhookService({
      prisma,
    });
  });

  describe('send', () => {
    it('should save event and create deliveries for matching endpoints', async () => {
      const eventId = 'evt-123';
      prisma.$queryRaw
        // First call: insert event
        .mockResolvedValueOnce([{ id: eventId }])
        // Second call: find matching endpoints
        .mockResolvedValueOnce([
          { id: 'ep-1', url: 'https://a.com/hook', secret: 'sec1', events: ['test.created'], active: true },
          { id: 'ep-2', url: 'https://b.com/hook', secret: 'sec2', events: ['*'], active: true },
        ]);

      prisma.$executeRawUnsafe.mockResolvedValueOnce(2);

      const result = await service.send(new TestEvent('t1'));

      expect(result).toBe(eventId);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);

      // Verify batch insert SQL contains both endpoint IDs
      const insertSql = prisma.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(insertSql).toContain('ep-1');
      expect(insertSql).toContain('ep-2');
    });

    it('should return eventId even when no matching endpoints', async () => {
      const eventId = 'evt-456';
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: eventId }])
        .mockResolvedValueOnce([]); // no matching endpoints

      const result = await service.send(new TestEvent('t2'));

      expect(result).toBe(eventId);
      expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    });
  });

  describe('sendToTenant', () => {
    it('should filter endpoints by tenantId', async () => {
      const eventId = 'evt-789';
      prisma.$queryRaw
        .mockResolvedValueOnce([{ id: eventId }])
        .mockResolvedValueOnce([
          { id: 'ep-t1', url: 'https://tenant.com/hook', secret: 's', events: ['test.created'], active: true },
        ]);
      prisma.$executeRawUnsafe.mockResolvedValueOnce(1);

      const result = await service.sendToTenant('tenant-1', new TestEvent('t3'));

      expect(result).toBe(eventId);
      // The second $queryRaw call should include tenant filtering
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });
});
