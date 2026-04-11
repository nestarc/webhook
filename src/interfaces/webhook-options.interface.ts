import { ModuleMetadata, Type } from '@nestjs/common';

export interface SigningOptions {
  algorithm?: 'sha256';
  headerName?: string;
}

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
  prisma: any;
  signing?: SigningOptions;
  delivery?: DeliveryOptions;
  circuitBreaker?: CircuitBreakerOptions;
  polling?: PollingOptions;
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
