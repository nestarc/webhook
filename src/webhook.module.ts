import {
  DynamicModule,
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryWorker } from './webhook.delivery-worker';
import { WebhookSigner } from './webhook.signer';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookAdminService } from './webhook.admin.service';
import {
  WEBHOOK_MODULE_OPTIONS,
  DEFAULT_POLLING_INTERVAL,
} from './webhook.constants';
import {
  WebhookModuleOptions,
  WebhookModuleAsyncOptions,
  WebhookOptionsFactory,
} from './interfaces/webhook-options.interface';

@Global()
@Module({})
export class WebhookModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly deliveryWorker: WebhookDeliveryWorker,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    private readonly options: WebhookModuleOptions,
  ) {}

  static forRoot(options: WebhookModuleOptions): DynamicModule {
    return {
      module: WebhookModule,
      imports: [ScheduleModule.forRoot()],
      providers: [
        {
          provide: WEBHOOK_MODULE_OPTIONS,
          useValue: options,
        },
        WebhookSigner,
        WebhookCircuitBreaker,
        WebhookService,
        WebhookDeliveryWorker,
        WebhookAdminService,
      ],
      exports: [WebhookService, WebhookAdminService, WebhookSigner],
    };
  }

  static forRootAsync(asyncOptions: WebhookModuleAsyncOptions): DynamicModule {
    const providers = [];

    if (asyncOptions.useFactory) {
      providers.push({
        provide: WEBHOOK_MODULE_OPTIONS,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      });
    } else if (asyncOptions.useClass) {
      providers.push(
        {
          provide: asyncOptions.useClass,
          useClass: asyncOptions.useClass,
        },
        {
          provide: WEBHOOK_MODULE_OPTIONS,
          useFactory: (factory: WebhookOptionsFactory) =>
            factory.createWebhookOptions(),
          inject: [asyncOptions.useClass],
        },
      );
    } else if (asyncOptions.useExisting) {
      providers.push({
        provide: WEBHOOK_MODULE_OPTIONS,
        useFactory: (factory: WebhookOptionsFactory) =>
          factory.createWebhookOptions(),
        inject: [asyncOptions.useExisting],
      });
    }

    return {
      module: WebhookModule,
      imports: [ScheduleModule.forRoot(), ...(asyncOptions.imports ?? [])],
      providers: [
        ...providers,
        WebhookSigner,
        WebhookCircuitBreaker,
        WebhookService,
        WebhookDeliveryWorker,
        WebhookAdminService,
      ],
      exports: [WebhookService, WebhookAdminService, WebhookSigner],
    };
  }

  onModuleInit(): void {
    const interval = this.options.polling?.interval ?? DEFAULT_POLLING_INTERVAL;

    const intervalRef = setInterval(() => {
      this.deliveryWorker.poll();
    }, interval);

    this.schedulerRegistry.addInterval('webhook-delivery-poll', intervalRef);
  }

  onModuleDestroy(): void {
    try {
      this.schedulerRegistry.deleteInterval('webhook-delivery-poll');
    } catch {
      // Already cleaned up
    }
  }
}
