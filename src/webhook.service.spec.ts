import { WebhookService } from './webhook.service';
import { WebhookEvent } from './webhook.event';

class TestEvent extends WebhookEvent {
  static readonly eventType = 'test.created';
  constructor(public readonly testId: string) {
    super();
  }
}

function createMockPrisma() {
  const txClient = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
  };

  const prisma = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    $executeRawUnsafe: jest.fn(),
    $transaction: jest.fn((cb: (tx: typeof txClient) => Promise<unknown>) => cb(txClient)),
  };

  return { prisma, txClient };
}

describe('WebhookService', () => {
  let service: WebhookService;
  let prisma: ReturnType<typeof createMockPrisma>['prisma'];
  let txClient: ReturnType<typeof createMockPrisma>['txClient'];

  beforeEach(() => {
    const mocks = createMockPrisma();
    prisma = mocks.prisma;
    txClient = mocks.txClient;
    service = new WebhookService({ prisma });
  });

  describe('send', () => {
    it('should save event and create deliveries within a transaction', async () => {
      const eventId = 'evt-123';
      txClient.$queryRaw
        .mockResolvedValueOnce([{ id: eventId }])
        .mockResolvedValueOnce([
          { id: 'ep-1', url: 'https://a.com/hook', secret: 'sec1', events: ['test.created'], active: true },
          { id: 'ep-2', url: 'https://b.com/hook', secret: 'sec2', events: ['*'], active: true },
        ]);
      txClient.$executeRawUnsafe.mockResolvedValueOnce(2);

      const result = await service.send(new TestEvent('t1'));

      expect(result).toBe(eventId);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txClient.$queryRaw).toHaveBeenCalledTimes(2);
      expect(txClient.$executeRawUnsafe).toHaveBeenCalledTimes(1);

      // Verify parameterized INSERT uses unnest
      const insertSql = txClient.$executeRawUnsafe.mock.calls[0][0] as string;
      expect(insertSql).toContain('unnest');
      // Verify endpoint IDs are passed as parameters, not interpolated
      const endpointIdsArg = txClient.$executeRawUnsafe.mock.calls[0][2];
      expect(endpointIdsArg).toEqual(['ep-1', 'ep-2']);
    });

    it('should return eventId even when no matching endpoints', async () => {
      const eventId = 'evt-456';
      txClient.$queryRaw
        .mockResolvedValueOnce([{ id: eventId }])
        .mockResolvedValueOnce([]);

      const result = await service.send(new TestEvent('t2'));

      expect(result).toBe(eventId);
      expect(txClient.$executeRawUnsafe).not.toHaveBeenCalled();
    });

    it('should rollback when delivery creation fails', async () => {
      txClient.$queryRaw
        .mockResolvedValueOnce([{ id: 'evt-err' }])
        .mockResolvedValueOnce([
          { id: 'ep-1', url: 'https://a.com/hook', secret: 'sec1', events: ['test.created'], active: true },
        ]);
      txClient.$executeRawUnsafe.mockRejectedValueOnce(new Error('DB constraint violation'));

      await expect(service.send(new TestEvent('t-fail'))).rejects.toThrow('DB constraint violation');
    });
  });

  describe('sendToTenant', () => {
    it('should filter endpoints by tenantId', async () => {
      const eventId = 'evt-789';
      txClient.$queryRaw
        .mockResolvedValueOnce([{ id: eventId }])
        .mockResolvedValueOnce([
          { id: 'ep-t1', url: 'https://tenant.com/hook', secret: 's', events: ['test.created'], active: true },
        ]);
      txClient.$executeRawUnsafe.mockResolvedValueOnce(1);

      const result = await service.sendToTenant('tenant-1', new TestEvent('t3'));

      expect(result).toBe(eventId);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(txClient.$queryRaw).toHaveBeenCalledTimes(2);
    });
  });
});
