import {
  DeliveryAttemptRecord,
  DeliveryLogFilters,
  DeliveryRecord,
  DeliveryResult,
} from '../interfaces/webhook-delivery.interface';

declare const webhookTransactionBrand: unique symbol;

/** Opaque transaction token created by repository adapters. */
export type WebhookTransaction = {
  readonly [webhookTransactionBrand]: 'WebhookTransaction';
};

/** A delivery row claimed by the worker but not yet enriched with endpoint/event data. */
export interface ClaimedDelivery {
  id: string;
  eventId: string;
  endpointId: string;
  attempts: number;
  maxAttempts: number;
}

/** A claimed delivery enriched with endpoint URL, signing secrets, and event payload. Ready to dispatch. */
export interface PendingDelivery extends ClaimedDelivery {
  tenantId: string | null;
  url: string;
  secret: string;
  additionalSecrets: string[];
  eventType: string;
  payload: Record<string, unknown>;
}

export interface WebhookDeliveryRepository {
  /**
   * Creates queued delivery rows inside the provided transaction.
   * No-op when endpointIds is empty.
   */
  createDeliveriesInTransaction(
    tx: WebhookTransaction,
    eventId: string,
    endpointIds: string[],
    maxAttempts: number,
  ): Promise<void>;

  /** Runs the callback in one repository transaction. Pass the tx only to other *InTransaction port methods. */
  runInTransaction<T>(fn: (tx: WebhookTransaction) => Promise<T>): Promise<T>;

  /** Atomically claims pending rows and returns the minimal delivery identity needed for enrichment. */
  claimPendingDeliveries(batchSize: number): Promise<ClaimedDelivery[]>;
  enrichDeliveries(deliveryIds: string[]): Promise<PendingDelivery[]>;

  markSent(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void>;
  markFailed(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void>;
  markRetry(deliveryId: string, attempts: number, nextAt: Date, result: DeliveryResult): Promise<void>;

  /** @returns number of stale SENDING deliveries recovered or failed. */
  recoverStaleSending(stalenessMinutes: number): Promise<number>;
  getDeliveryLogs(endpointId: string, filters?: DeliveryLogFilters): Promise<DeliveryRecord[]>;
  /** @returns attempts sorted by attemptNumber ASC. */
  getDeliveryAttempts(deliveryId: string): Promise<DeliveryAttemptRecord[]>;
  retryDelivery(deliveryId: string): Promise<boolean>;
  createTestDelivery(eventId: string, endpointId: string): Promise<void>;
}
