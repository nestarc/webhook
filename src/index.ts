// Module
export { WebhookModule } from './webhook.module';

// Core services
export { WebhookService } from './webhook.service';
/** @internal Wired automatically by WebhookModule. Exported for advanced testing/custom integration only. */
export { WebhookDeliveryWorker } from './webhook.delivery-worker';
/** @internal Wired automatically by WebhookModule. Exported for advanced testing/custom integration only. */
export { WebhookDispatcher } from './webhook.dispatcher';
/** @internal Wired automatically by WebhookModule. Exported for advanced testing/custom integration only. */
export { WebhookRetryPolicy } from './webhook.retry-policy';
export { WebhookSigner, type SignatureHeaders } from './webhook.signer';
/** @internal Wired automatically by WebhookModule. Exported for advanced testing/custom integration only. */
export { WebhookCircuitBreaker } from './webhook.circuit-breaker';
export { WebhookEvent } from './webhook.event';

// Admin services
export { WebhookEndpointAdminService } from './webhook.endpoint-admin.service';
export { WebhookDeliveryAdminService } from './webhook.delivery-admin.service';
/** @deprecated since v0.2.0. Will be removed in v1.0.0. Use {@link WebhookEndpointAdminService} and {@link WebhookDeliveryAdminService}. */
export { WebhookAdminService } from './webhook.admin.service';

// Port interfaces
export type { WebhookEventRepository } from './ports/webhook-event.repository';
export type {
  WebhookEndpointRepository,
  ResolvedCreateEndpointInput,
  ResolvedRotateEndpointSecretInput,
} from './ports/webhook-endpoint.repository';
export type {
  WebhookDeliveryRepository,
  ClaimedDelivery,
  DeliveryBacklogSummary,
  PendingDelivery,
  WebhookTransaction,
} from './ports/webhook-delivery.repository';
export type { WebhookHttpClient } from './ports/webhook-http-client';
export type { WebhookSecretVault } from './ports/webhook-secret-vault';

// Default adapters
export { PrismaEventRepository } from './adapters/prisma-event.repository';
export { PrismaEndpointRepository } from './adapters/prisma-endpoint.repository';
export { PrismaDeliveryRepository } from './adapters/prisma-delivery.repository';
export { FetchHttpClient } from './adapters/fetch-http-client';
export { PlaintextSecretVault } from './adapters/plaintext-secret-vault';

// Option types
export type {
  WebhookModuleOptions,
  WebhookModuleAsyncOptions,
  WebhookOptionsFactory,
  DeliveryOptions,
  CircuitBreakerOptions,
  PollingOptions,
  WebhookPollContext,
  WebhookPollResult,
  WebhookDeliveryProcessingStatus,
  WebhookDeliveryProcessingResult,
  WebhookWorkerObserver,
  DeliveryFailedContext,
  DeliveryFailureKind,
  DeliveryRetryScheduledContext,
  EndpointDisabledContext,
  EndpointDegradedContext,
} from './interfaces/webhook-options.interface';

// Record types
export type {
  EndpointRecord,
  EndpointRecordWithSecret,
  CreateEndpointDto,
  UpdateEndpointDto,
  RotateEndpointSecretDto,
} from './interfaces/webhook-endpoint.interface';

export type {
  DeliveryStatus,
  DeliveryAttemptStatus,
  DeliveryRecord,
  DeliveryAttemptRecord,
  EventRecord,
  DeliveryResult,
  DeliveryLogFilters,
} from './interfaces/webhook-delivery.interface';

// Constants & tokens
export {
  WEBHOOK_MODULE_OPTIONS,
  WEBHOOK_EVENT_REPOSITORY,
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_HTTP_CLIENT,
  WEBHOOK_SECRET_VAULT,
  DEFAULT_BACKOFF_SCHEDULE,
  DEFAULT_DELIVERY_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_POLLING_BATCH_SIZE,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES,
  ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
  DEFAULT_STALE_SENDING_MINUTES,
} from './webhook.constants';
export type { EndpointDisabledReason } from './webhook.constants';

// URL validation
export {
  validateWebhookUrl,
  resolveAndValidateHost,
  WebhookUrlValidationError,
  type WebhookUrlValidationReason,
} from './webhook.url-validator';
