import { ModuleMetadata, Type } from '@nestjs/common';
import { WebhookEventRepository } from '../ports/webhook-event.repository';
import { WebhookEndpointRepository } from '../ports/webhook-endpoint.repository';
import { WebhookDeliveryRepository } from '../ports/webhook-delivery.repository';
import { WebhookHttpClient } from '../ports/webhook-http-client';

export interface DeliveryOptions {
  timeout?: number;
  maxRetries?: number;
  backoff?: 'exponential';
  jitter?: boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMinutes?: number;
}

export interface PollingOptions {
  interval?: number;
  batchSize?: number;
}

export interface WebhookModuleOptions {
  /** PrismaClient instance — used by default Prisma adapters. Not needed if all custom repositories are provided. */
  prisma?: any;
  delivery?: DeliveryOptions;
  circuitBreaker?: CircuitBreakerOptions;
  polling?: PollingOptions;
  /** Allow private/internal URLs for endpoints. Only enable in development/testing. Default: false */
  allowPrivateUrls?: boolean;
  /** Custom port overrides — provide these to replace default Prisma/fetch adapters. */
  eventRepository?: WebhookEventRepository;
  endpointRepository?: WebhookEndpointRepository;
  deliveryRepository?: WebhookDeliveryRepository;
  httpClient?: WebhookHttpClient;
}

export interface WebhookOptionsFactory {
  createWebhookOptions(): Promise<WebhookModuleOptions> | WebhookModuleOptions;
}

export interface WebhookModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: any[]) => Promise<WebhookModuleOptions> | WebhookModuleOptions;
  inject?: any[];
  useClass?: Type<WebhookOptionsFactory>;
  useExisting?: Type<WebhookOptionsFactory>;
}
