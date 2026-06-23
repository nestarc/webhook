import { Injectable } from '@nestjs/common';
import {
  ClaimedDelivery,
  DeliveryBacklogSummary,
  PendingDelivery,
  WebhookDeliveryRepository,
  WebhookTransaction,
} from '../ports/webhook-delivery.repository';
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
import {
  WebhookRedactionOptions,
  WebhookRetentionOptions,
} from '../interfaces/webhook-options.interface';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';
import {
  ATTEMPT_RESPONSE_BODY_MAX_LENGTH,
  DEFAULT_MAX_RETRIES,
} from '../webhook.constants';

type AttemptLogClient = {
  $executeRaw: <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
};

type RawDeliveryBacklogSummary = {
  pendingCount: unknown;
  sendingCount: unknown;
  runnablePendingCount: unknown;
  oldestPendingAgeMs: unknown | null;
  oldestRunnableAgeMs: unknown | null;
};

type RawRetryFailedDeliveriesResult = {
  matched: unknown;
  retried: unknown;
  skipped: unknown;
};

type RawReplayEventResult = {
  eventId: string;
  sourceEventCount: unknown;
  deliveriesCreated: unknown;
  endpointIds: string[] | null;
};

type RawRetentionPurgeResult = {
  eventsPurged: unknown;
  deliveriesPurged: unknown;
  attemptsPurged: unknown;
};

const STALE_SENDING_RECOVERY_ERROR =
  'Recovered stale SENDING delivery after worker lease expired';

function truncateAttemptResponseBody(body: string | null | undefined) {
  if (body == null) {
    return {
      responseBody: null,
      responseBodyTruncated: false,
    };
  }

  if (body.length <= ATTEMPT_RESPONSE_BODY_MAX_LENGTH) {
    return {
      responseBody: body,
      responseBodyTruncated: false,
    };
  }

  return {
    responseBody: body.slice(0, ATTEMPT_RESPONSE_BODY_MAX_LENGTH),
    responseBodyTruncated: true,
  };
}

function normalizeBacklogNumber(value: unknown, field: string): number {
  const normalized = Number(value);

  if (!Number.isFinite(normalized)) {
    throw new Error(`Invalid backlog summary ${field}: ${String(value)}`);
  }

  return normalized;
}

@Injectable()
export class PrismaDeliveryRepository implements WebhookDeliveryRepository {
  constructor(
    protected readonly prisma: any,
    protected readonly vault?: WebhookSecretVault,
    protected readonly redaction?: WebhookRedactionOptions,
  ) {}

  async createDeliveriesInTransaction(
    tx: any,
    eventId: string,
    endpointIds: string[],
    maxAttempts: number,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO webhook_deliveries (
         event_id,
         endpoint_id,
         status,
         attempts,
         max_attempts,
         next_attempt_at,
         endpoint_url_snapshot,
         signing_secret_snapshot,
         secondary_signing_secret_snapshot
       )
       SELECT
         $1::uuid,
         e.id,
         'PENDING',
         0,
         $3,
         NOW(),
         e.url,
         e.secret,
         CASE
           WHEN e.previous_secret IS NOT NULL
            AND e.previous_secret_expires_at IS NOT NULL
            AND e.previous_secret_expires_at > NOW()
           THEN e.previous_secret
           ELSE NULL
         END
       FROM webhook_endpoints e
       JOIN webhook_events ev ON ev.id = $1::uuid
       WHERE e.id = ANY($2::uuid[])
         AND e.active = true
         AND (ev.tenant_id IS NULL OR e.tenant_id = ev.tenant_id)
         AND (ev.event_type = ANY(e.events) OR '*' = ANY(e.events))`,
      eventId,
      endpointIds,
      maxAttempts,
    );
  }

  async runInTransaction<T>(fn: (tx: WebhookTransaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async claimPendingDeliveries(batchSize: number): Promise<ClaimedDelivery[]> {
    return this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE webhook_deliveries
      SET status = 'SENDING', claimed_at = NOW()
      WHERE id IN (
        SELECT d.id
        FROM webhook_deliveries d
        WHERE d.status = 'PENDING'
          AND d.next_attempt_at <= NOW()
        ORDER BY d.next_attempt_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING
        webhook_deliveries.id,
        webhook_deliveries.event_id AS "eventId",
        webhook_deliveries.endpoint_id AS "endpointId",
        webhook_deliveries.attempts,
        webhook_deliveries.max_attempts AS "maxAttempts"`;
  }

  async enrichDeliveries(deliveryIds: string[]): Promise<PendingDelivery[]> {
    const rows = await this.prisma.$queryRaw<PendingDelivery[]>`
      SELECT
        d.id,
        d.event_id AS "eventId",
        d.endpoint_id AS "endpointId",
        d.attempts,
        d.max_attempts AS "maxAttempts",
        e.tenant_id::text AS "tenantId",
        COALESCE(d.endpoint_url_snapshot, e.url) AS url,
        COALESCE(d.signing_secret_snapshot, e.secret) AS secret,
        CASE
          WHEN d.secondary_signing_secret_snapshot IS NULL
          THEN ARRAY[]::text[]
          ELSE ARRAY[d.secondary_signing_secret_snapshot]
        END AS "additionalSecrets",
        ev.event_type AS "eventType",
        ev.payload
      FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
      JOIN webhook_events ev ON ev.id = d.event_id
      WHERE d.id = ANY(${deliveryIds}::uuid[])`;

    if (this.vault) {
      await Promise.all(
        rows.map(async (row: PendingDelivery) => {
          const [secret, additionalSecrets] = await Promise.all([
            this.vault!.decrypt(row.secret),
            Promise.all(
              row.additionalSecrets.map((secret: string) =>
                this.vault!.decrypt(secret),
              ),
            ),
          ]);

          row.secret = secret;
          row.additionalSecrets = additionalSecrets;
        }),
      );
    }

    return rows;
  }

  async markSent(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void> {
    const sanitizedResult = this.sanitizeDeliveryResult(deliveryId, result);
    await this.prisma.$transaction(async (tx: AttemptLogClient) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'SENT', attempts = ${attempts},
            last_attempt_at = NOW(), completed_at = NOW(),
            response_status = ${sanitizedResult.statusCode ?? null},
            response_body = ${sanitizedResult.body ?? null},
            latency_ms = ${sanitizedResult.latencyMs}
        WHERE id = ${deliveryId}::uuid`;
      await this.appendAttemptLog(tx, deliveryId, attempts, 'SENT', sanitizedResult);
    });
  }

  async markFailed(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void> {
    const sanitizedResult = this.sanitizeDeliveryResult(deliveryId, result);
    await this.prisma.$transaction(async (tx: AttemptLogClient) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'FAILED', attempts = ${attempts},
            last_attempt_at = NOW(), completed_at = NOW(),
            next_attempt_at = NULL,
            response_status = ${sanitizedResult.statusCode ?? null},
            response_body = ${sanitizedResult.body ?? null},
            latency_ms = ${sanitizedResult.latencyMs},
            last_error = ${sanitizedResult.error ?? null}
        WHERE id = ${deliveryId}::uuid`;
      await this.appendAttemptLog(tx, deliveryId, attempts, 'FAILED', sanitizedResult);
    });
  }

  async markRetry(
    deliveryId: string,
    attempts: number,
    nextAt: Date,
    result: DeliveryResult,
  ): Promise<void> {
    const sanitizedResult = this.sanitizeDeliveryResult(deliveryId, result);
    await this.prisma.$transaction(async (tx: AttemptLogClient) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'PENDING', attempts = ${attempts},
            last_attempt_at = NOW(), next_attempt_at = ${nextAt},
            response_status = ${sanitizedResult.statusCode ?? null},
            response_body = ${sanitizedResult.body ?? null},
            latency_ms = ${sanitizedResult.latencyMs},
            last_error = ${sanitizedResult.error ?? null}
        WHERE id = ${deliveryId}::uuid`;
      await this.appendAttemptLog(tx, deliveryId, attempts, 'PENDING', sanitizedResult);
    });
  }

  async recoverStaleSending(stalenessMinutes: number): Promise<number> {
    const interval = `${stalenessMinutes} minutes`;
    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH recovered AS (
        UPDATE webhook_deliveries
        SET attempts = attempts + 1,
            status = CASE
              WHEN attempts + 1 >= max_attempts THEN 'FAILED'
              ELSE 'PENDING'
            END,
            claimed_at = NULL,
            last_attempt_at = NOW(),
            next_attempt_at = CASE
              WHEN attempts + 1 >= max_attempts THEN NULL
              ELSE NOW()
            END,
            completed_at = CASE
              WHEN attempts + 1 >= max_attempts THEN NOW()
              ELSE completed_at
            END,
            response_status = NULL,
            response_body = NULL,
            latency_ms = NULL,
            last_error = ${STALE_SENDING_RECOVERY_ERROR}
        WHERE status = 'SENDING'
          AND claimed_at IS NOT NULL
          AND claimed_at < NOW() - ${interval}::interval
        RETURNING id, attempts, status
      ),
      attempt_log AS (
        INSERT INTO webhook_delivery_attempts (
          delivery_id,
          attempt_number,
          status,
          response_status,
          response_body,
          response_body_truncated,
          latency_ms,
          last_error
        )
        SELECT
          id,
          attempts,
          status,
          NULL,
          NULL,
          FALSE,
          NULL,
          ${STALE_SENDING_RECOVERY_ERROR}
        FROM recovered
        ON CONFLICT (delivery_id, attempt_number) DO NOTHING
        RETURNING delivery_id
      )
      SELECT recovered.id
      FROM recovered
      LEFT JOIN attempt_log ON attempt_log.delivery_id = recovered.id`;
    return recovered.length;
  }

  async getBacklogSummary(): Promise<DeliveryBacklogSummary> {
    const rows = await this.prisma.$queryRaw<RawDeliveryBacklogSummary[]>`
      WITH backlog AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'PENDING') AS "pendingCount",
          COUNT(*) FILTER (WHERE status = 'SENDING') AS "sendingCount",
          COUNT(*) FILTER (
            WHERE status = 'PENDING'
              AND next_attempt_at <= NOW()
          ) AS "runnablePendingCount",
          MIN(next_attempt_at) FILTER (
            WHERE status = 'PENDING'
          ) AS "oldestPendingAt",
          MIN(next_attempt_at) FILTER (
            WHERE status = 'PENDING'
              AND next_attempt_at <= NOW()
          ) AS "oldestRunnableAt"
        FROM webhook_deliveries
      )
      SELECT
        "pendingCount",
        "sendingCount",
        "runnablePendingCount",
        CASE
          WHEN "oldestPendingAt" IS NULL THEN NULL
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - "oldestPendingAt")) * 1000)::bigint
          )
        END AS "oldestPendingAgeMs",
        CASE
          WHEN "oldestRunnableAt" IS NULL THEN NULL
          ELSE GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - "oldestRunnableAt")) * 1000)::bigint
          )
        END AS "oldestRunnableAgeMs"
      FROM backlog`;

    const row = rows[0];

    if (!row) {
      return {
        pendingCount: 0,
        sendingCount: 0,
        runnablePendingCount: 0,
        oldestPendingAgeMs: null,
        oldestRunnableAgeMs: null,
      };
    }

    return {
      pendingCount: normalizeBacklogNumber(row.pendingCount, 'pendingCount'),
      sendingCount: normalizeBacklogNumber(row.sendingCount, 'sendingCount'),
      runnablePendingCount: normalizeBacklogNumber(
        row.runnablePendingCount,
        'runnablePendingCount',
      ),
      oldestPendingAgeMs:
        row.oldestPendingAgeMs == null
          ? null
          : normalizeBacklogNumber(row.oldestPendingAgeMs, 'oldestPendingAgeMs'),
      oldestRunnableAgeMs:
        row.oldestRunnableAgeMs == null
          ? null
          : normalizeBacklogNumber(
              row.oldestRunnableAgeMs,
              'oldestRunnableAgeMs',
            ),
    };
  }

  async getDeliveryLogs(
    endpointId: string,
    filters?: DeliveryLogFilters,
  ): Promise<DeliveryRecord[]> {
    const conditions = ['d.endpoint_id = $1::uuid'];
    const values: unknown[] = [endpointId];
    let paramIndex = 2;

    if (filters?.status) {
      conditions.push(`d.status = $${paramIndex++}`);
      values.push(filters.status);
    }
    if (filters?.eventType) {
      conditions.push(`ev.event_type = $${paramIndex++}`);
      values.push(filters.eventType);
    }
    if (filters?.since) {
      conditions.push(`d.last_attempt_at >= $${paramIndex++}`);
      values.push(filters.since);
    }
    if (filters?.until) {
      conditions.push(`d.last_attempt_at <= $${paramIndex++}`);
      values.push(filters.until);
    }

    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    const query = `
      SELECT d.id, d.status, d.attempts,
             d.event_id AS "eventId",
             d.endpoint_id AS "endpointId",
             COALESCE(d.endpoint_url_snapshot, ep.url) AS "destinationUrl",
             ep.tenant_id::text AS "tenantId",
             d.max_attempts AS "maxAttempts",
             d.next_attempt_at AS "nextAttemptAt",
             d.last_attempt_at AS "lastAttemptAt",
             d.completed_at AS "completedAt",
             d.response_status AS "responseStatus",
             d.response_body AS "responseBody",
             d.latency_ms AS "latencyMs",
             d.last_error AS "lastError"
      FROM webhook_deliveries d
      JOIN webhook_events ev ON ev.id = d.event_id
      JOIN webhook_endpoints ep ON ep.id = d.endpoint_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.last_attempt_at DESC NULLS LAST
      LIMIT $${paramIndex++}
      OFFSET $${paramIndex}`;
    values.push(limit, offset);

    const results: DeliveryRecord[] = await this.prisma.$queryRawUnsafe(query, ...values);
    return results;
  }

  async getDeliveryAttempts(deliveryId: string): Promise<DeliveryAttemptRecord[]> {
    return this.prisma.$queryRaw<DeliveryAttemptRecord[]>`
      SELECT
        id,
        delivery_id AS "deliveryId",
        attempt_number AS "attemptNumber",
        status,
        response_status AS "responseStatus",
        response_body AS "responseBody",
        response_body_truncated AS "responseBodyTruncated",
        latency_ms AS "latencyMs",
        last_error AS "lastError",
        created_at AS "createdAt"
      FROM webhook_delivery_attempts
      WHERE delivery_id = ${deliveryId}::uuid
      ORDER BY attempt_number ASC`;
  }

  async retryDelivery(
    deliveryId: string,
    _options?: RetryDeliveryOptions,
  ): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'PENDING',
          next_attempt_at = NOW(),
          max_attempts = GREATEST(max_attempts, attempts + 1)
      WHERE id = ${deliveryId}::uuid AND status = 'FAILED'`;
    return result > 0;
  }

  async retryFailedDeliveries(
    filters: RetryFailedDeliveriesFilters,
    _options?: RetryDeliveryOptions,
  ): Promise<RetryFailedDeliveriesResult> {
    if (filters.status && filters.status !== 'FAILED') {
      return { matched: 0, retried: 0, skipped: 0 };
    }

    const limit = filters.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error('Bulk retry limit must be between 1 and 1000');
    }

    const conditions = [`d.status = 'FAILED'`];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (filters.endpointId) {
      conditions.push(`d.endpoint_id = $${paramIndex++}::uuid`);
      values.push(filters.endpointId);
    }
    if (filters.eventType) {
      conditions.push(`ev.event_type = $${paramIndex++}`);
      values.push(filters.eventType);
    }
    if (filters.since) {
      conditions.push(`d.completed_at >= $${paramIndex++}`);
      values.push(filters.since);
    }
    if (filters.until) {
      conditions.push(`d.completed_at <= $${paramIndex++}`);
      values.push(filters.until);
    }

    values.push(limit);
    const query = `
      WITH candidates AS (
        SELECT d.id
        FROM webhook_deliveries d
        JOIN webhook_events ev ON ev.id = d.event_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY d.completed_at DESC NULLS LAST, d.id
        LIMIT $${paramIndex}
        FOR UPDATE SKIP LOCKED
      ),
      updated AS (
        UPDATE webhook_deliveries d
        SET status = 'PENDING',
            next_attempt_at = NOW(),
            max_attempts = GREATEST(max_attempts, attempts + 1)
        WHERE d.id IN (SELECT id FROM candidates)
        RETURNING d.id
      )
      SELECT
        (SELECT COUNT(*) FROM candidates) AS matched,
        (SELECT COUNT(*) FROM updated) AS retried,
        (SELECT COUNT(*) FROM candidates) - (SELECT COUNT(*) FROM updated) AS skipped`;

    const rows = (await this.prisma.$queryRawUnsafe(
      query,
      ...values,
    )) as RawRetryFailedDeliveriesResult[];
    const [result] = rows;

    return {
      matched: normalizeBacklogNumber(result?.matched ?? 0, 'matched'),
      retried: normalizeBacklogNumber(result?.retried ?? 0, 'retried'),
      skipped: normalizeBacklogNumber(result?.skipped ?? 0, 'skipped'),
    };
  }

  async replayEvent(
    eventId: string,
    options?: ReplayEventOptions,
  ): Promise<ReplayEventResult> {
    const tenantId = options?.tenantId ?? null;
    const endpointIds = options?.endpointIds ?? null;
    const [result] = await this.prisma.$queryRaw<RawReplayEventResult[]>`
      WITH source_event AS (
        SELECT ev.id, ev.event_type, ev.tenant_id
        FROM webhook_events ev
        WHERE ev.id = ${eventId}::uuid
          AND ev.payload_purged_at IS NULL
          AND (${tenantId}::text IS NULL OR ev.tenant_id = ${tenantId})
      ),
      selected_endpoints AS (
        SELECT
          e.id,
          e.url,
          e.secret,
          CASE
            WHEN e.previous_secret IS NOT NULL
             AND e.previous_secret_expires_at IS NOT NULL
             AND e.previous_secret_expires_at > NOW()
            THEN e.previous_secret
            ELSE NULL
          END AS secondary_secret
        FROM webhook_endpoints e
        JOIN source_event ev ON true
        WHERE e.active = true
          AND (ev.tenant_id IS NULL OR e.tenant_id = ev.tenant_id)
          AND (${tenantId}::text IS NULL OR e.tenant_id = ${tenantId})
          AND (${endpointIds}::uuid[] IS NULL OR e.id = ANY(${endpointIds}::uuid[]))
          AND (ev.event_type = ANY(e.events) OR '*' = ANY(e.events))
      ),
      inserted AS (
        INSERT INTO webhook_deliveries (
          event_id,
          endpoint_id,
          status,
          attempts,
          max_attempts,
          next_attempt_at,
          endpoint_url_snapshot,
          signing_secret_snapshot,
          secondary_signing_secret_snapshot
        )
        SELECT
          ${eventId}::uuid,
          e.id,
          'PENDING',
          0,
          ${DEFAULT_MAX_RETRIES},
          NOW(),
          e.url,
          e.secret,
          e.secondary_secret
        FROM selected_endpoints e
        RETURNING endpoint_id
      )
      SELECT
        ${eventId} AS "eventId",
        (SELECT COUNT(*) FROM source_event) AS "sourceEventCount",
        COUNT(inserted.endpoint_id) AS "deliveriesCreated",
        COALESCE(array_agg(inserted.endpoint_id::text)
          FILTER (WHERE inserted.endpoint_id IS NOT NULL), ARRAY[]::text[]) AS "endpointIds"
      FROM inserted`;

    if (normalizeBacklogNumber(result?.sourceEventCount ?? 0, 'sourceEventCount') === 0) {
      throw new Error('Webhook event is missing or its payload has been purged');
    }

    return {
      eventId: result.eventId,
      deliveriesCreated: normalizeBacklogNumber(
        result.deliveriesCreated,
        'deliveriesCreated',
      ),
      endpointIds: result.endpointIds ?? [],
    };
  }

  async purgeExpiredData(
    options: WebhookRetentionOptions,
    now = new Date(),
  ): Promise<WebhookRetentionPurgeResult> {
    const eventPayloadRetentionDays = options.eventPayloadRetentionDays ?? null;
    const deliveryResponseBodyRetentionDays =
      options.deliveryResponseBodyRetentionDays ?? null;
    const attemptResponseBodyRetentionDays =
      options.attemptResponseBodyRetentionDays ?? null;

    if (
      eventPayloadRetentionDays == null &&
      deliveryResponseBodyRetentionDays == null &&
      attemptResponseBodyRetentionDays == null
    ) {
      return { eventsPurged: 0, deliveriesPurged: 0, attemptsPurged: 0 };
    }

    const [result] = await this.prisma.$queryRaw<RawRetentionPurgeResult[]>`
      WITH event_payloads AS (
        UPDATE webhook_events ev
        SET payload = '{}'::jsonb,
            payload_purged_at = ${now}
        WHERE ${eventPayloadRetentionDays}::int IS NOT NULL
          AND ev.payload_purged_at IS NULL
          AND ev.created_at <= ${now} - (${eventPayloadRetentionDays}::text || ' days')::interval
          AND NOT EXISTS (
            SELECT 1
            FROM webhook_deliveries d
            WHERE d.event_id = ev.id
              AND d.status IN ('PENDING', 'SENDING')
          )
        RETURNING ev.id
      ),
      delivery_bodies AS (
        UPDATE webhook_deliveries d
        SET response_body = NULL
        WHERE ${deliveryResponseBodyRetentionDays}::int IS NOT NULL
          AND d.response_body IS NOT NULL
          AND d.completed_at IS NOT NULL
          AND d.completed_at <= ${now} - (${deliveryResponseBodyRetentionDays}::text || ' days')::interval
        RETURNING d.id
      ),
      attempt_bodies AS (
        UPDATE webhook_delivery_attempts a
        SET response_body = NULL,
            response_body_truncated = FALSE
        WHERE ${attemptResponseBodyRetentionDays}::int IS NOT NULL
          AND a.response_body IS NOT NULL
          AND a.created_at <= ${now} - (${attemptResponseBodyRetentionDays}::text || ' days')::interval
        RETURNING a.id
      )
      SELECT
        (SELECT COUNT(*) FROM event_payloads) AS "eventsPurged",
        (SELECT COUNT(*) FROM delivery_bodies) AS "deliveriesPurged",
        (SELECT COUNT(*) FROM attempt_bodies) AS "attemptsPurged"`;

    return {
      eventsPurged: normalizeBacklogNumber(result?.eventsPurged ?? 0, 'eventsPurged'),
      deliveriesPurged: normalizeBacklogNumber(
        result?.deliveriesPurged ?? 0,
        'deliveriesPurged',
      ),
      attemptsPurged: normalizeBacklogNumber(
        result?.attemptsPurged ?? 0,
        'attemptsPurged',
      ),
    };
  }

  async createTestDelivery(eventId: string, endpointId: string): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO webhook_deliveries (
        event_id,
        endpoint_id,
        status,
        max_attempts,
        next_attempt_at,
        endpoint_url_snapshot,
        signing_secret_snapshot,
        secondary_signing_secret_snapshot
      )
      SELECT
        ${eventId}::uuid,
        e.id,
        'PENDING',
        1,
        NOW(),
        e.url,
        e.secret,
        CASE
          WHEN e.previous_secret IS NOT NULL
           AND e.previous_secret_expires_at IS NOT NULL
           AND e.previous_secret_expires_at > NOW()
          THEN e.previous_secret
          ELSE NULL
        END
      FROM webhook_endpoints e
      WHERE e.id = ${endpointId}::uuid`;
  }

  protected async appendAttemptLog(
    client: AttemptLogClient,
    deliveryId: string,
    attempts: number,
    status: 'PENDING' | 'SENT' | 'FAILED',
    result: DeliveryResult,
  ): Promise<void> {
    const { responseBody, responseBodyTruncated } =
      truncateAttemptResponseBody(result.body ?? null);

    await client.$executeRaw`
      INSERT INTO webhook_delivery_attempts (
        delivery_id,
        attempt_number,
        status,
        response_status,
        response_body,
        response_body_truncated,
        latency_ms,
        last_error
      )
      VALUES (
        ${deliveryId}::uuid,
        ${attempts},
        ${status},
        ${result.statusCode ?? null},
        ${responseBody},
        ${responseBodyTruncated},
        ${result.latencyMs},
        ${result.error ?? null}
      )`;
  }

  private sanitizeDeliveryResult(
    deliveryId: string,
    result: DeliveryResult,
  ): DeliveryResult {
    if (result.body == null || !this.redaction?.sanitizeResponseBody) {
      return result;
    }

    const sanitizedBody = this.redaction.sanitizeResponseBody(result.body, {
      deliveryId,
      endpointId: null,
      eventId: null,
      statusCode: result.statusCode ?? null,
    });

    return {
      ...result,
      body: sanitizedBody ?? undefined,
    };
  }
}
