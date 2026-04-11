import {
  DynamicModule,
  Global,
  Inject,
  Module,
  OnModuleDestroy,
  OnModuleInit,
  Provider,
} from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { WebhookService } from './webhook.service';
import { WebhookDeliveryWorker } from './webhook.delivery-worker';
import { WebhookSigner } from './webhook.signer';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookRetryPolicy } from './webhook.retry-policy';
import { WebhookEndpointAdminService } from './webhook.endpoint-admin.service';
import { WebhookDeliveryAdminService } from './webhook.delivery-admin.service';
import { WebhookAdminService } from './webhook.admin.service';
import {
  WEBHOOK_MODULE_OPTIONS,
  WEBHOOK_EVENT_REPOSITORY,
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_HTTP_CLIENT,
  DEFAULT_POLLING_INTERVAL,
} from './webhook.constants';
import {
  WebhookModuleOptions,
  WebhookModuleAsyncOptions,
  WebhookOptionsFactory,
} from './interfaces/webhook-options.interface';
import { PrismaEventRepository } from './adapters/prisma-event.repository';
import { PrismaEndpointRepository } from './adapters/prisma-endpoint.repository';
import { PrismaDeliveryRepository } from './adapters/prisma-delivery.repository';
import { FetchHttpClient } from './adapters/fetch-http-client';

function createPortProviders(options: WebhookModuleOptions): Provider[] {
  return [
    {
      provide: WEBHOOK_EVENT_REPOSITORY,
      useFactory: () =>
        options.eventRepository ?? new PrismaEventRepository(options.prisma),
    },
    {
      provide: WEBHOOK_ENDPOINT_REPOSITORY,
      useFactory: () =>
        options.endpointRepository ??
        new PrismaEndpointRepository(options.prisma),
    },
    {
      provide: WEBHOOK_DELIVERY_REPOSITORY,
      useFactory: () =>
        options.deliveryRepository ??
        new PrismaDeliveryRepository(options.prisma),
    },
    {
      provide: WEBHOOK_HTTP_CLIENT,
      useFactory: () => options.httpClient ?? new FetchHttpClient(),
    },
  ];
}

function createAsyncPortProviders(): Provider[] {
  return [
    {
      provide: WEBHOOK_EVENT_REPOSITORY,
      useFactory: (opts: WebhookModuleOptions) =>
        opts.eventRepository ?? new PrismaEventRepository(opts.prisma),
      inject: [WEBHOOK_MODULE_OPTIONS],
    },
    {
      provide: WEBHOOK_ENDPOINT_REPOSITORY,
      useFactory: (opts: WebhookModuleOptions) =>
        opts.endpointRepository ?? new PrismaEndpointRepository(opts.prisma),
      inject: [WEBHOOK_MODULE_OPTIONS],
    },
    {
      provide: WEBHOOK_DELIVERY_REPOSITORY,
      useFactory: (opts: WebhookModuleOptions) =>
        opts.deliveryRepository ?? new PrismaDeliveryRepository(opts.prisma),
      inject: [WEBHOOK_MODULE_OPTIONS],
    },
    {
      provide: WEBHOOK_HTTP_CLIENT,
      useFactory: (opts: WebhookModuleOptions) =>
        opts.httpClient ?? new FetchHttpClient(),
      inject: [WEBHOOK_MODULE_OPTIONS],
    },
  ];
}

const CORE_PROVIDERS = [
  WebhookSigner,
  WebhookRetryPolicy,
  WebhookCircuitBreaker,
  WebhookDispatcher,
  WebhookService,
  WebhookDeliveryWorker,
  WebhookEndpointAdminService,
  WebhookDeliveryAdminService,
  WebhookAdminService,
];

const EXPORTS = [
  WebhookService,
  WebhookEndpointAdminService,
  WebhookDeliveryAdminService,
  WebhookAdminService,
  WebhookSigner,
];

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
        { provide: WEBHOOK_MODULE_OPTIONS, useValue: options },
        ...createPortProviders(options),
        ...CORE_PROVIDERS,
      ],
      exports: EXPORTS,
    };
  }

  static forRootAsync(asyncOptions: WebhookModuleAsyncOptions): DynamicModule {
    const optionsProviders: Provider[] = [];

    if (asyncOptions.useFactory) {
      optionsProviders.push({
        provide: WEBHOOK_MODULE_OPTIONS,
        useFactory: asyncOptions.useFactory,
        inject: asyncOptions.inject ?? [],
      });
    } else if (asyncOptions.useClass) {
      optionsProviders.push(
        { provide: asyncOptions.useClass, useClass: asyncOptions.useClass },
        {
          provide: WEBHOOK_MODULE_OPTIONS,
          useFactory: (factory: WebhookOptionsFactory) =>
            factory.createWebhookOptions(),
          inject: [asyncOptions.useClass],
        },
      );
    } else if (asyncOptions.useExisting) {
      optionsProviders.push({
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
        ...optionsProviders,
        ...createAsyncPortProviders(),
        ...CORE_PROVIDERS,
      ],
      exports: EXPORTS,
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
