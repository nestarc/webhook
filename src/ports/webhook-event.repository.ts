import { WebhookTransaction } from './webhook-delivery.repository';
import { WebhookPublishOptions } from '../interfaces/webhook-options.interface';

export interface SavedWebhookEvent {
  id: string;
  created: boolean;
}

export interface WebhookEventRepository {
  /** Save a new event; correlation metadata does not require an idempotency key. */
  saveEvent(
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
    options?: Pick<WebhookPublishOptions, 'correlationId'>,
  ): Promise<string>;

  /**
   * Use only with a transaction object received from WebhookDeliveryRepository.runInTransaction().
   * Persist options.correlationId when present, independently of idempotent publishing.
   */
  saveEventInTransaction(
    tx: WebhookTransaction,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
    options?: Pick<WebhookPublishOptions, 'correlationId'>,
  ): Promise<string>;

  saveEventOnceInTransaction?(
    tx: WebhookTransaction,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
    options: Required<Pick<WebhookPublishOptions, 'idempotencyKey'>> &
      Pick<WebhookPublishOptions, 'correlationId'>,
  ): Promise<SavedWebhookEvent>;
}
