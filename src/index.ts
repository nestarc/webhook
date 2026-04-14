// Module
export { WebhookModule } from './webhook.module';

// Core services
export { WebhookService } from './webhook.service';
export { WebhookDeliveryWorker } from './webhook.delivery-worker';
export { WebhookDispatcher } from './webhook.dispatcher';
export { WebhookRetryPolicy } from './webhook.retry-policy';
export { WebhookSigner, type SignatureHeaders } from './webhook.signer';
export { WebhookCircuitBreaker } from './webhook.circuit-breaker';
export { WebhookEvent } from './webhook.event';

// Admin services
export { WebhookEndpointAdminService } from './webhook.endpoint-admin.service';
export { WebhookDeliveryAdminService } from './webhook.delivery-admin.service';
/** @deprecated Use WebhookEndpointAdminService and WebhookDeliveryAdminService */
export { WebhookAdminService } from './webhook.admin.service';

// Port interfaces
export type { WebhookEventRepository } from './ports/webhook-event.repository';
export type { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
export type {
  WebhookDeliveryRepository,
  PendingDelivery,
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
  DeliveryFailedContext,
  DeliveryFailureKind,
  EndpointDisabledContext,
} from './interfaces/webhook-options.interface';

// Record types
export type {
  EndpointRecord,
  EndpointRecordWithSecret,
  CreateEndpointDto,
  UpdateEndpointDto,
} from './interfaces/webhook-endpoint.interface';

export type {
  DeliveryStatus,
  DeliveryRecord,
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
  DEFAULT_BACKOFF_SCHEDULE,
  DEFAULT_DELIVERY_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_POLLING_INTERVAL,
  DEFAULT_POLLING_BATCH_SIZE,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES,
  DEFAULT_STALE_SENDING_MINUTES,
} from './webhook.constants';

export {
  validateWebhookUrl,
  resolveAndValidateHost,
  WebhookUrlValidationError,
  type WebhookUrlValidationReason,
} from './webhook.url-validator';
