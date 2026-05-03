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
  degradedThreshold?: number;
  cooldownMinutes?: number;
}

export interface PollingOptions {
  /** Set to false to disable the polling loop. Useful for API-only processes where a separate worker handles delivery. Default: true */
  enabled?: boolean;
  interval?: number;
  batchSize?: number;
  /** Minutes before a SENDING delivery is considered stale and reset to PENDING. Default: 5 */
  staleSendingMinutes?: number;
  /** Maximum delivery dispatches in flight per worker process. Default: batchSize */
  maxConcurrency?: number;
  /** When true, one poll cycle keeps claiming while backlog and capacity remain. Default: false */
  drainWhileBacklogged?: boolean;
  /** Maximum claim/drain loops inside one poll cycle. Default: 1, or 10 when drainWhileBacklogged is true */
  maxDrainLoopsPerPoll?: number;
  /** Optional sleep between continuous drain loops. Default: 0 */
  drainLoopDelayMs?: number;
}

export interface WebhookPollContext {
  batchSize: number;
  maxConcurrency: number;
  drainWhileBacklogged: boolean;
  maxDrainLoopsPerPoll: number;
  drainLoopDelayMs: number;
  activeDeliveries: number;
}

export interface WebhookPollResult {
  claimed: number;
  enriched: number;
  sent: number;
  failed: number;
  retried: number;
  recoveredStale: number;
  durationMs: number;
  loops: number;
}

export type WebhookDeliveryProcessingStatus = 'sent' | 'failed' | 'retried';

export interface WebhookDeliveryProcessingResult {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  tenantId: string | null;
  attempts: number;
  maxAttempts: number;
  status: WebhookDeliveryProcessingStatus;
  responseStatus: number | null;
  lastError: string | null;
  latencyMs: number | null;
  nextAttemptAt?: Date;
  failureKind?: DeliveryFailureKind;
  validationReason?: WebhookUrlValidationReason;
  validationUrl?: string;
  resolvedIp?: string;
}

export interface WebhookWorkerObserver {
  onPollStart?(context: WebhookPollContext): void;
  onPollComplete?(result: WebhookPollResult): void;
  onDeliveryComplete?(result: WebhookDeliveryProcessingResult): void;
  onPollError?(error: unknown): void;
}

/**
 * Category of failure that caused the delivery to stop after retry exhaustion
 * or after a non-retryable receiver response.
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

export interface DeliveryRetryScheduledContext {
  deliveryId: string;
  endpointId: string;
  eventId: string;
  /** Null when the endpoint is not scoped to a tenant. */
  tenantId: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  responseStatus: number | null;

  /** High-level classification for the failed attempt that scheduled the retry. */
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

export interface EndpointDegradedContext {
  endpointId: string;
  /** Null when the endpoint is not scoped to a tenant. */
  tenantId: string | null;
  url: string;
  reason: 'consecutive_failures_degraded';
  consecutiveFailures: number;
  degradedThreshold: number;
  failureThreshold: number;
}

export interface WebhookModuleOptions<TPrisma = unknown> {
  /** PrismaClient instance — used by default Prisma adapters. Not needed if all custom repositories are provided. */
  prisma?: TPrisma;
  delivery?: DeliveryOptions;
  circuitBreaker?: CircuitBreakerOptions;
  polling?: PollingOptions;
  /** Best-effort worker lifecycle and delivery metrics observer. Observer errors are logged and ignored. */
  workerObserver?: WebhookWorkerObserver;
  /** Allow private/internal URLs for endpoints. Only enable in development/testing. Default: false */
  allowPrivateUrls?: boolean;
  /** Custom port overrides — provide these to replace default Prisma/fetch adapters. */
  eventRepository?: WebhookEventRepository;
  endpointRepository?: WebhookEndpointRepository;
  deliveryRepository?: WebhookDeliveryRepository;
  httpClient?: WebhookHttpClient;
  /** Custom secret vault for encrypting/decrypting endpoint signing secrets at rest. Default: PlaintextSecretVault (no-op). */
  secretVault?: WebhookSecretVault;

  /** Called when a delivery exhausts retry attempts or receives a non-retryable response. Fire-and-forget — errors are logged, not propagated. */
  onDeliveryFailed?: (context: DeliveryFailedContext) => void | Promise<void>;

  /** Called after a retriable failed attempt is persisted with a next attempt time. Fire-and-forget — errors are logged, not propagated. */
  onDeliveryRetryScheduled?: (
    context: DeliveryRetryScheduledContext,
  ) => void | Promise<void>;

  /** Called when consecutive failures reach the configured degraded threshold before endpoint disablement. Fire-and-forget — errors are logged, not propagated. */
  onEndpointDegraded?: (context: EndpointDegradedContext) => void | Promise<void>;

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
