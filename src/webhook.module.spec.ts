import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Injectable } from '@nestjs/common';
import { WebhookModule } from './webhook.module';
import { WebhookService } from './webhook.service';
import { WebhookAdminService } from './webhook.admin.service';
import { WebhookSigner } from './webhook.signer';
import { WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import {
  WebhookModuleOptions,
  WebhookOptionsFactory,
} from './interfaces/webhook-options.interface';

const mockPrisma = {
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  $transaction: jest.fn(),
};

describe('WebhookModule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('forRoot', () => {
    let module: TestingModule;

    afterEach(async () => {
      await module?.close();
    });

    it('should provide WebhookService, WebhookAdminService, and WebhookSigner', async () => {
      module = await Test.createTestingModule({
        imports: [
          WebhookModule.forRoot({
            prisma: mockPrisma,
            polling: { interval: 999_999 },
          }),
        ],
      }).compile();

      expect(module.get(WebhookService)).toBeInstanceOf(WebhookService);
      expect(module.get(WebhookAdminService)).toBeInstanceOf(WebhookAdminService);
      expect(module.get(WebhookSigner)).toBeInstanceOf(WebhookSigner);
    });

    it('should inject the provided options via WEBHOOK_MODULE_OPTIONS token', async () => {
      const opts: WebhookModuleOptions = {
        prisma: mockPrisma,
        delivery: { maxRetries: 7 },
        polling: { interval: 999_999 },
      };

      module = await Test.createTestingModule({
        imports: [WebhookModule.forRoot(opts)],
      }).compile();

      const injected = module.get(WEBHOOK_MODULE_OPTIONS);
      expect(injected).toBe(opts);
      expect(injected.delivery?.maxRetries).toBe(7);
    });
  });

  describe('forRootAsync — useFactory', () => {
    let module: TestingModule;

    afterEach(async () => {
      await module?.close();
    });

    it('should resolve services when options come from useFactory', async () => {
      const factory = jest.fn().mockReturnValue({
        prisma: mockPrisma,
        polling: { interval: 999_999 },
      });

      module = await Test.createTestingModule({
        imports: [
          WebhookModule.forRootAsync({
            useFactory: factory,
          }),
        ],
      }).compile();

      expect(factory).toHaveBeenCalledTimes(1);
      expect(module.get(WebhookService)).toBeInstanceOf(WebhookService);
      expect(module.get(WEBHOOK_MODULE_OPTIONS)).toEqual({
        prisma: mockPrisma,
        polling: { interval: 999_999 },
      });
    });
  });

  describe('forRootAsync — useClass', () => {
    let module: TestingModule;

    afterEach(async () => {
      await module?.close();
    });

    it('should call createWebhookOptions on the provided class', async () => {
      @Injectable()
      class TestOptionsFactory implements WebhookOptionsFactory {
        createWebhookOptions(): WebhookModuleOptions {
          return {
            prisma: mockPrisma,
            delivery: { maxRetries: 10 },
            polling: { interval: 999_999 },
          };
        }
      }

      module = await Test.createTestingModule({
        imports: [
          WebhookModule.forRootAsync({
            useClass: TestOptionsFactory,
          }),
        ],
      }).compile();

      const opts = module.get(WEBHOOK_MODULE_OPTIONS);
      expect(opts.delivery?.maxRetries).toBe(10);
      expect(module.get(WebhookService)).toBeInstanceOf(WebhookService);
    });
  });

  describe('lifecycle — onModuleInit / onModuleDestroy', () => {
    let module: TestingModule;

    afterEach(async () => {
      await module?.close();
    });

    it('should register polling interval on init and remove on destroy', async () => {
      module = await Test.createTestingModule({
        imports: [
          WebhookModule.forRoot({
            prisma: mockPrisma,
            polling: { interval: 999_999 },
          }),
        ],
      }).compile();

      const registry = module.get(SchedulerRegistry);

      // Before init — no interval
      expect(() => registry.getInterval('webhook-delivery-poll')).toThrow();

      await module.init();

      // After init — interval registered
      const interval = registry.getInterval('webhook-delivery-poll');
      expect(interval).toBeDefined();

      await module.close();

      // After destroy — interval removed
      expect(() => registry.getInterval('webhook-delivery-poll')).toThrow();
    });

    it('should use custom polling interval from options', async () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      module = await Test.createTestingModule({
        imports: [
          WebhookModule.forRoot({
            prisma: mockPrisma,
            polling: { interval: 12345 },
          }),
        ],
      }).compile();

      await module.init();

      // setInterval should have been called with the custom interval
      const matchingCall = setIntervalSpy.mock.calls.find(
        (call) => call[1] === 12345,
      );
      expect(matchingCall).toBeDefined();
    });
  });
});
