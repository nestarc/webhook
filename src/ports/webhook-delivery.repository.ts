import {
  DeliveryAttemptRecord,
  DeliveryLogFilters,
  DeliveryRecord,
  DeliveryResult,
  ReplayEventOptions,
  ReplayEventResult,
  RetryDeliveryOptions,
  RetryFailedDeliveriesFilters,
  RetryFailedDeliveriesResult,
  WebhookRetentionPurgeResult,
} from '../interfaces/webhook-delivery.interface';
import { WebhookRetentionOptions } from '../interfaces/webhook-options.interface';

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

export interface DeliveryBacklogSummary {
  pendingCount: number;
  sendingCount: number;
  runnablePendingCount: number;
  oldestPendingAgeMs: number | null;
  oldestRunnableAgeMs: number | null;
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
  getBacklogSummary?(): Promise<DeliveryBacklogSummary>;
  getDeliveryLogs(endpointId: string, filters?: DeliveryLogFilters): Promise<DeliveryRecord[]>;
  /** @returns attempts sorted by attemptNumber ASC. */
  getDeliveryAttempts(deliveryId: string): Promise<DeliveryAttemptRecord[]>;
  retryDelivery(deliveryId: string, options?: RetryDeliveryOptions): Promise<boolean>;
  retryFailedDeliveries?(
    filters: RetryFailedDeliveriesFilters,
    options?: RetryDeliveryOptions,
  ): Promise<RetryFailedDeliveriesResult>;
  replayEvent?(
    eventId: string,
    options?: ReplayEventOptions,
  ): Promise<ReplayEventResult>;
  purgeExpiredData?(
    options: WebhookRetentionOptions,
    now?: Date,
  ): Promise<WebhookRetentionPurgeResult>;
  createTestDelivery(eventId: string, endpointId: string): Promise<void>;
}
