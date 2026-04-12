import { ModuleMetadata, Type } from '@nestjs/common';
import { WebhookEventRepository } from '../ports/webhook-event.repository';
import { WebhookEndpointRepository } from '../ports/webhook-endpoint.repository';
import { WebhookDeliveryRepository } from '../ports/webhook-delivery.repository';
import { WebhookHttpClient } from '../ports/webhook-http-client';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';

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
  /** Set to false to disable the polling loop. Useful for API-only processes where a separate worker handles delivery. Default: true */
  enabled?: boolean;
  interval?: number;
  batchSize?: number;
  /** Minutes before a SENDING delivery is considered stale and reset to PENDING. Default: 5 */
  staleSendingMinutes?: number;
}

export interface DeliveryFailedContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  tenantId: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  responseStatus: number | null;
}

export interface EndpointDisabledContext {
  endpointId: string;
  tenantId: string;
  url: string;
  reason: string;
  consecutiveFailures: number;
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
  /** Custom secret vault for encrypting/decrypting endpoint signing secrets at rest. Default: PlaintextSecretVault (no-op). */
  secretVault?: WebhookSecretVault;

  /** Called when a delivery exhausts all retry attempts. Fire-and-forget — errors are logged, not propagated. */
  onDeliveryFailed?: (context: DeliveryFailedContext) => void | Promise<void>;

  /** Called when the circuit breaker disables an endpoint. Fire-and-forget — errors are logged, not propagated. */
  onEndpointDisabled?: (context: EndpointDisabledContext) => void | Promise<void>;
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
