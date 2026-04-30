import { WebhookEndpointAdminService } from './webhook.endpoint-admin.service';
import { WebhookSigner } from './webhook.signer';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import { WebhookEventRepository } from './ports/webhook-event.repository';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';
import { EndpointRecord } from './interfaces/webhook-endpoint.interface';

function makeEndpoint(overrides: Partial<EndpointRecord> = {}): EndpointRecord {
  return {
    id: 'ep-1', url: 'https://example.com/hook',
    events: ['order.created'], active: true, description: null, metadata: null,
    tenantId: null, consecutiveFailures: 0, disabledAt: null, disabledReason: null,
    previousSecretExpiresAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  };
}

function createMocks() {
  const endpointRepo = {
    createEndpoint: jest.fn(),
    getEndpoint: jest.fn(),
    listEndpoints: jest.fn(),
    updateEndpoint: jest.fn(),
    deleteEndpoint: jest.fn(),
  };
  const eventRepo = { saveEvent: jest.fn(), saveEventInTransaction: jest.fn() };
  const deliveryRepo = { createTestDelivery: jest.fn() };
  const signer = new WebhookSigner();
  return { endpointRepo, eventRepo, deliveryRepo, signer };
}

describe('WebhookEndpointAdminService', () => {
  let service: WebhookEndpointAdminService;
  let mocks: ReturnType<typeof createMocks>;

  beforeEach(() => {
    mocks = createMocks();
    service = new WebhookEndpointAdminService(
      mocks.endpointRepo as unknown as WebhookEndpointRepository,
      mocks.eventRepo as unknown as WebhookEventRepository,
      mocks.deliveryRepo as unknown as WebhookDeliveryRepository,
      mocks.signer,
      {}, // options — allowPrivateUrls defaults to false
    );
  });

  describe('createEndpoint', () => {
    it('should auto-generate secret when "auto"', async () => {
      mocks.endpointRepo.createEndpoint.mockResolvedValueOnce({ ...makeEndpoint(), secret: 'auto-generated' });

      await service.createEndpoint({
        url: 'https://example.com', events: ['*'], secret: 'auto',
      });

      // Secret arg should be a base64 string (auto-generated)
      const secretArg = mocks.endpointRepo.createEndpoint.mock.calls[0][1];
      expect(Buffer.from(secretArg, 'base64').length).toBe(32);
    });

    it('should use provided valid secret', async () => {
      const validSecret = Buffer.from('a'.repeat(32)).toString('base64');
      mocks.endpointRepo.createEndpoint.mockResolvedValueOnce(
        { ...makeEndpoint(), secret: validSecret },
      );

      await service.createEndpoint({
        url: 'https://example.com', events: ['*'], secret: validSecret,
      });

      expect(mocks.endpointRepo.createEndpoint.mock.calls[0][1]).toBe(validSecret);
    });

    it('should reject invalid base64 secret', async () => {
      await expect(
        service.createEndpoint({
          url: 'https://example.com', events: ['*'], secret: '!!!invalid!!!',
        }),
      ).rejects.toThrow('Invalid secret');
    });

    it('should reject short secret', async () => {
      const shortSecret = Buffer.from('short').toString('base64');
      await expect(
        service.createEndpoint({
          url: 'https://example.com', events: ['*'], secret: shortSecret,
        }),
      ).rejects.toThrow('at least 16 bytes');
    });
  });

  describe('SSRF protection', () => {
    it('should reject private IP in createEndpoint', async () => {
      await expect(
        service.createEndpoint({ url: 'http://10.0.0.1/hook', events: ['*'] }),
      ).rejects.toThrow('private address');
    });

    it('should reject localhost in createEndpoint', async () => {
      await expect(
        service.createEndpoint({ url: 'http://localhost/hook', events: ['*'] }),
      ).rejects.toThrow('loopback');
    });

    it('should reject metadata IP in createEndpoint', async () => {
      await expect(
        service.createEndpoint({ url: 'http://169.254.169.254/meta', events: ['*'] }),
      ).rejects.toThrow();
    });

    it('should reject private IP in updateEndpoint', async () => {
      await expect(
        service.updateEndpoint('ep-1', { url: 'http://192.168.1.1/hook' }),
      ).rejects.toThrow('private address');
    });

    it('should allow update without URL change', async () => {
      mocks.endpointRepo.updateEndpoint.mockResolvedValueOnce(makeEndpoint({ active: false }));
      const result = await service.updateEndpoint('ep-1', { active: false });
      expect(result!.active).toBe(false);
    });
  });

  describe('CRUD delegation', () => {
    it('listEndpoints', async () => {
      mocks.endpointRepo.listEndpoints.mockResolvedValueOnce([makeEndpoint()]);
      const result = await service.listEndpoints('t1');
      expect(mocks.endpointRepo.listEndpoints).toHaveBeenCalledWith('t1');
      expect(result).toHaveLength(1);
    });

    it('getEndpoint', async () => {
      mocks.endpointRepo.getEndpoint.mockResolvedValueOnce(makeEndpoint());
      const result = await service.getEndpoint('ep-1');
      expect(result!.id).toBe('ep-1');
    });

    it('updateEndpoint', async () => {
      mocks.endpointRepo.updateEndpoint.mockResolvedValueOnce(makeEndpoint({ url: 'https://new.com' }));
      const result = await service.updateEndpoint('ep-1', { url: 'https://new.com' });
      expect(result!.url).toBe('https://new.com');
    });

    it('deleteEndpoint', async () => {
      mocks.endpointRepo.deleteEndpoint.mockResolvedValueOnce(true);
      expect(await service.deleteEndpoint('ep-1')).toBe(true);
    });
  });

  describe('sendTestEvent', () => {
    it('should create test event and delivery', async () => {
      mocks.endpointRepo.getEndpoint.mockResolvedValueOnce(makeEndpoint());
      mocks.eventRepo.saveEvent.mockResolvedValueOnce('evt-test');
      mocks.deliveryRepo.createTestDelivery.mockResolvedValueOnce(undefined);

      const result = await service.sendTestEvent('ep-1');

      expect(result).toBe('evt-test');
      expect(mocks.eventRepo.saveEvent).toHaveBeenCalledWith('webhook.test', { test: true }, null);
      expect(mocks.deliveryRepo.createTestDelivery).toHaveBeenCalledWith('evt-test', 'ep-1');
    });

    it('should return null for non-existent endpoint', async () => {
      mocks.endpointRepo.getEndpoint.mockResolvedValueOnce(null);
      expect(await service.sendTestEvent('non-existent')).toBeNull();
    });
  });
});
