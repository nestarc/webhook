import { Injectable } from '@nestjs/common';
import {
  ClaimedDelivery,
  PendingDelivery,
  WebhookDeliveryRepository,
  WebhookTransaction,
} from '../ports/webhook-delivery.repository';
import {
  DeliveryAttemptRecord,
  DeliveryLogFilters,
  DeliveryRecord,
  DeliveryResult,
} from '../interfaces/webhook-delivery.interface';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';
import { ATTEMPT_RESPONSE_BODY_MAX_LENGTH } from '../webhook.constants';

type AttemptLogClient = {
  $executeRaw: <T = unknown>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<T>;
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

@Injectable()
export class PrismaDeliveryRepository implements WebhookDeliveryRepository {
  constructor(
    protected readonly prisma: any,
    protected readonly vault?: WebhookSecretVault,
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
       WHERE e.id = ANY($2::uuid[])`,
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
    await this.prisma.$transaction(async (tx: AttemptLogClient) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'SENT', attempts = ${attempts},
            last_attempt_at = NOW(), completed_at = NOW(),
            response_status = ${result.statusCode ?? null},
            response_body = ${result.body ?? null},
            latency_ms = ${result.latencyMs}
        WHERE id = ${deliveryId}::uuid`;
      await this.appendAttemptLog(tx, deliveryId, attempts, 'SENT', result);
    });
  }

  async markFailed(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void> {
    await this.prisma.$transaction(async (tx: AttemptLogClient) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'FAILED', attempts = ${attempts},
            last_attempt_at = NOW(), completed_at = NOW(),
            next_attempt_at = NULL,
            response_status = ${result.statusCode ?? null},
            response_body = ${result.body ?? null},
            latency_ms = ${result.latencyMs},
            last_error = ${result.error ?? null}
        WHERE id = ${deliveryId}::uuid`;
      await this.appendAttemptLog(tx, deliveryId, attempts, 'FAILED', result);
    });
  }

  async markRetry(
    deliveryId: string,
    attempts: number,
    nextAt: Date,
    result: DeliveryResult,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx: AttemptLogClient) => {
      await tx.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'PENDING', attempts = ${attempts},
            last_attempt_at = NOW(), next_attempt_at = ${nextAt},
            response_status = ${result.statusCode ?? null},
            response_body = ${result.body ?? null},
            latency_ms = ${result.latencyMs},
            last_error = ${result.error ?? null}
        WHERE id = ${deliveryId}::uuid`;
      await this.appendAttemptLog(tx, deliveryId, attempts, 'PENDING', result);
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
          AND claimed_at + ${interval}::interval < NOW()
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

  async retryDelivery(deliveryId: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'PENDING', next_attempt_at = NOW()
      WHERE id = ${deliveryId}::uuid AND status = 'FAILED'`;
    return result > 0;
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
}
