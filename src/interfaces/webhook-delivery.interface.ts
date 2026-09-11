export type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
export type DeliveryAttemptStatus = Exclude<DeliveryStatus, 'SENDING'>;

export interface DeliveryRecord {
  id: string;
  eventId: string;
  endpointId: string;
  /** Destination URL used for this delivery. Uses the queued snapshot when available. */
  destinationUrl: string;
  /** Null when the endpoint is global rather than tenant-scoped. */
  tenantId: string | null;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
  responseStatus: number | null;
  responseBody: string | null;
  latencyMs: number | null;
  lastError: string | null;
}

export interface DeliveryAttemptRecord {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  status: DeliveryAttemptStatus;
  responseStatus: number | null;
  responseBody: string | null;
  responseBodyTruncated: boolean;
  latencyMs: number | null;
  lastError: string | null;
  createdAt: Date;
}

export interface EventRecord {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  tenantId: string | null;
  createdAt: Date;
}

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  body?: string;
  latencyMs: number;
  error?: string;
}

export interface DeliveryLogFilters {
  status?: DeliveryStatus;
  eventType?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
}

export interface RetryDeliveryOptions {
  /** Metadata for custom repositories. The built-in Prisma adapter does not persist this value. */
  reason?: string;
}

export interface RetryFailedDeliveriesFilters extends DeliveryLogFilters {
  endpointId?: string;
}

export interface RetryFailedDeliveriesResult {
  /** Failed deliveries selected by the batch, excluding rows locked by another operation. */
  matched: number;
  retried: number;
  /** Selected deliveries not retried, including events whose payload was purged. */
  skipped: number;
}

export interface ReplayEventOptions {
  endpointIds?: string[];
  tenantId?: string;
  /** Metadata for custom repositories. The built-in Prisma adapter does not persist this value. */
  reason?: string;
}

export interface ReplayEventResult {
  eventId: string;
  deliveriesCreated: number;
  endpointIds: string[];
}

export interface WebhookRetentionPurgeResult {
  eventsPurged: number;
  deliveriesPurged: number;
  attemptsPurged: number;
}
