import { WebhookTransaction } from './webhook-delivery.repository';

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
}
