import { PrismaEventRepository } from './prisma-event.repository';

describe('PrismaEventRepository', () => {
  describe('saveEvent', () => {
    it('stores tenant IDs as opaque strings without UUID casts', async () => {
      const prisma = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'event-1' }]),
      };
      const repo = new PrismaEventRepository(prisma);

      await expect(
        repo.saveEvent('order.created', { orderId: 'ord-1' }, 'tenant_123'),
      ).resolves.toBe('event-1');

      const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(sql).toContain('tenant_id');
      expect(sql).not.toContain('tenantId}::uuid');
      expect(sql).not.toContain('::uuid');
      expect(prisma.$queryRaw.mock.calls[0]).toContain('tenant_123');
    });
  });

  describe('saveEventInTransaction', () => {
    it('stores tenant IDs as opaque strings without UUID casts inside transactions', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: 'event-2' }]),
      };
      const repo = new PrismaEventRepository({});

      await expect(
        repo.saveEventInTransaction(
          tx,
          'order.paid',
          { orderId: 'ord-1' },
          'tenant_123',
        ),
      ).resolves.toBe('event-2');

      const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(sql).toContain('tenant_id');
      expect(sql).not.toContain('tenantId}::uuid');
      expect(sql).not.toContain('::uuid');
      expect(tx.$queryRaw.mock.calls[0]).toContain('tenant_123');
    });
  });

  describe('saveEventOnceInTransaction', () => {
    it('returns created=true when the idempotent event is inserted', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'event-3',
            created: true,
          },
        ]),
      };
      const repo = new PrismaEventRepository({});

      await expect(
        (repo as any).saveEventOnceInTransaction(
          tx,
          'order.created',
          { orderId: 'ord-1' },
          'tenant_123',
          {
            idempotencyKey: 'order-1:create',
            correlationId: 'req-1',
          },
        ),
      ).resolves.toEqual({ id: 'event-3', created: true });

      const sql = (tx.$queryRaw.mock.calls[0][0] as TemplateStringsArray)
        .join(' ')
        .replace(/\s+/g, ' ');
      expect(sql).toContain('idempotency_key');
      expect(sql).toContain('ON CONFLICT');
      expect(sql).not.toContain('tenantId}::uuid');
      expect(sql).not.toContain('::uuid');
      expect(tx.$queryRaw.mock.calls[0]).toContain('tenant_123');
      expect(tx.$queryRaw.mock.calls[0]).toContain('order-1:create');
      expect(tx.$queryRaw.mock.calls[0]).toContain('req-1');
    });

    it('returns created=false when the idempotent event already exists', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            id: 'event-existing',
            created: false,
          },
        ]),
      };
      const repo = new PrismaEventRepository({});

      await expect(
        (repo as any).saveEventOnceInTransaction(
          tx,
          'order.created',
          { orderId: 'ord-1' },
          'tenant_123',
          {
            idempotencyKey: 'order-1:create',
          },
        ),
      ).resolves.toEqual({ id: 'event-existing', created: false });
    });
  });
});
