import {
  DeliveryLogFilters,
  DeliveryRecord,
  DeliveryResult,
} from '../interfaces/webhook-delivery.interface';

export interface PendingDelivery {
  id: string;
  event_id: string;
  endpoint_id: string;
  attempts: number;
  max_attempts: number;
  url: string;
  secret: string;
  event_type: string;
  payload: Record<string, unknown>;
}

export interface WebhookDeliveryRepository {
  createDeliveriesInTransaction(
    tx: unknown,
    eventId: string,
    endpointIds: string[],
    maxAttempts: number,
  ): Promise<void>;

  runInTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  claimPendingDeliveries(batchSize: number): Promise<PendingDelivery[]>;
  enrichDeliveries(deliveryIds: string[]): Promise<PendingDelivery[]>;

  markSent(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void>;
  markFailed(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void>;
  markRetry(deliveryId: string, attempts: number, nextAt: Date, result: DeliveryResult): Promise<void>;

  recoverStaleSending(stalenessMinutes: number): Promise<number>;
  getDeliveryLogs(endpointId: string, filters?: DeliveryLogFilters): Promise<DeliveryRecord[]>;
  retryDelivery(deliveryId: string): Promise<boolean>;
  createTestDelivery(eventId: string, endpointId: string): Promise<void>;
}
