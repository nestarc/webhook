import { WebhookTransaction } from './webhook-delivery.repository';
import { WebhookPublishOptions } from '../interfaces/webhook-options.interface';

export interface SavedWebhookEvent {
  id: string;
  created: boolean;
}

export interface WebhookEventRepository {
  saveEvent(
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
  ): Promise<string>;

  /** Use only with a transaction object received from WebhookDeliveryRepository.runInTransaction(). */
  saveEventInTransaction(
    tx: WebhookTransaction,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
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
