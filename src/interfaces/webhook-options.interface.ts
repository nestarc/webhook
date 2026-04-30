import {
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Type,
} from '@nestjs/common';
import { WebhookEventRepository } from '../ports/webhook-event.repository';
import { WebhookEndpointRepository } from '../ports/webhook-endpoint.repository';
import { WebhookDeliveryRepository } from '../ports/webhook-delivery.repository';
import { WebhookHttpClient } from '../ports/webhook-http-client';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';
import type { EndpointDisabledReason } from '../webhook.constants';
import { WebhookUrlValidationReason } from '../webhook.url-validator';

export interface DeliveryOptions {
  timeout?: number;
  maxRetries?: number;
  /** @deprecated Retry backoff is currently fixed to the default exponential schedule. */
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

/**
 * Category of failure that caused the delivery to exhaust retries.
 * - `url_validation`: SSRF defense rejected the URL (private/loopback/link-local/etc.)
 * - `dispatch_error`: dispatcher threw an exception (timeout, ECONNREFUSED, etc.)
 * - `http_error`: endpoint responded with a non-2xx status code
 */
export type DeliveryFailureKind = 'url_validation' | 'dispatch_error' | 'http_error';

export interface DeliveryFailedContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  /** Null when the endpoint is not scoped to a tenant. */
  tenantId: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  responseStatus: number | null;

  /** High-level classification. Built-in workers set this in v0.8.0+; optional for custom/legacy producers. */
  failureKind?: DeliveryFailureKind;
  /** Set only when `failureKind === 'url_validation'` — structured reason from `WebhookUrlValidationError`. */
  validationReason?: WebhookUrlValidationReason;
  /** Set only when `failureKind === 'url_validation'` — URL that triggered validation failure. */
  validationUrl?: string;
  /** Set only when `failureKind === 'url_validation'` and DNS resolution was involved. */
  resolvedIp?: string;
}

export interface EndpointDisabledContext {
  endpointId: string;
  /** Null when the endpoint is not scoped to a tenant. */
  tenantId: string | null;
  url: string;
  reason: EndpointDisabledReason;
  consecutiveFailures: number;
}

export interface WebhookModuleOptions<TPrisma = unknown> {
  /** PrismaClient instance — used by default Prisma adapters. Not needed if all custom repositories are provided. */
  prisma?: TPrisma;
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
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useClass?: Type<WebhookOptionsFactory>;
  useExisting?: Type<WebhookOptionsFactory>;
}
