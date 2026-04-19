import { Injectable } from '@nestjs/common';
import {
  PendingDelivery,
  WebhookDeliveryRepository,
} from '../ports/webhook-delivery.repository';
import {
  DeliveryAttemptRecord,
  DeliveryLogFilters,
  DeliveryRecord,
  DeliveryResult,
} from '../interfaces/webhook-delivery.interface';
import { WebhookSecretVault } from '../ports/webhook-secret-vault';

const MAX_ATTEMPT_RESPONSE_BODY_LENGTH = 4096;

function truncateAttemptResponseBody(body: string | null | undefined) {
  if (body == null) {
    return {
      responseBody: null,
      responseBodyTruncated: false,
    };
  }

  if (body.length <= MAX_ATTEMPT_RESPONSE_BODY_LENGTH) {
    return {
      responseBody: body,
      responseBodyTruncated: false,
    };
  }

  return {
    responseBody: body.slice(0, MAX_ATTEMPT_RESPONSE_BODY_LENGTH),
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

  async runInTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async claimPendingDeliveries(batchSize: number): Promise<PendingDelivery[]> {
    return this.prisma.$queryRaw<PendingDelivery[]>`
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
        webhook_deliveries.event_id,
        webhook_deliveries.endpoint_id,
        webhook_deliveries.attempts,
        webhook_deliveries.max_attempts`;
  }

  async enrichDeliveries(deliveryIds: string[]): Promise<PendingDelivery[]> {
    const rows = await this.prisma.$queryRaw<PendingDelivery[]>`
      SELECT
        d.id, d.event_id, d.endpoint_id, d.attempts, d.max_attempts,
        e.tenant_id::text AS tenant_id,
        COALESCE(d.endpoint_url_snapshot, e.url) AS url,
        COALESCE(d.signing_secret_snapshot, e.secret) AS secret,
        CASE
          WHEN d.secondary_signing_secret_snapshot IS NULL
          THEN ARRAY[]::text[]
          ELSE ARRAY[d.secondary_signing_secret_snapshot]
        END AS "additionalSecrets",
        ev.event_type, ev.payload
      FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
      JOIN webhook_events ev ON ev.id = d.event_id
      WHERE d.id = ANY(${deliveryIds}::uuid[])`;

    if (this.vault) {
      for (const row of rows) {
        row.secret = await this.vault.decrypt(row.secret);
        row.additionalSecrets = await Promise.all(
          (row.additionalSecrets ?? []).map((secret: string) =>
            this.vault!.decrypt(secret),
          ),
        );
      }
    }

    return rows;
  }

  async markSent(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'SENT', attempts = ${attempts},
          last_attempt_at = NOW(), completed_at = NOW(),
          response_status = ${result.statusCode ?? null},
          response_body = ${result.body ?? null},
          latency_ms = ${result.latencyMs}
      WHERE id = ${deliveryId}::uuid`;
    await this.appendAttemptLog(deliveryId, attempts, 'SENT', result);
  }

  async markFailed(deliveryId: string, attempts: number, result: DeliveryResult): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'FAILED', attempts = ${attempts},
          last_attempt_at = NOW(), completed_at = NOW(),
          response_status = ${result.statusCode ?? null},
          response_body = ${result.body ?? null},
          latency_ms = ${result.latencyMs},
          last_error = ${result.error ?? null}
      WHERE id = ${deliveryId}::uuid`;
    await this.appendAttemptLog(deliveryId, attempts, 'FAILED', result);
  }

  async markRetry(
    deliveryId: string,
    attempts: number,
    nextAt: Date,
    result: DeliveryResult,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'PENDING', attempts = ${attempts},
          last_attempt_at = NOW(), next_attempt_at = ${nextAt},
          response_status = ${result.statusCode ?? null},
          response_body = ${result.body ?? null},
          latency_ms = ${result.latencyMs},
          last_error = ${result.error ?? null}
      WHERE id = ${deliveryId}::uuid`;
    await this.appendAttemptLog(deliveryId, attempts, 'PENDING', result);
  }

  async recoverStaleSending(stalenessMinutes: number): Promise<number> {
    const interval = `${stalenessMinutes} minutes`;
    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE webhook_deliveries
      SET status = 'PENDING', claimed_at = NULL
      WHERE status = 'SENDING'
        AND claimed_at IS NOT NULL
        AND claimed_at + ${interval}::interval < NOW()
      RETURNING id`;
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
    deliveryId: string,
    attempts: number,
    status: 'PENDING' | 'SENT' | 'FAILED',
    result: DeliveryResult,
  ): Promise<void> {
    const { responseBody, responseBodyTruncated } =
      truncateAttemptResponseBody(result.body ?? null);

    try {
      await this.prisma.$executeRaw`
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Best-effort logging only. Delivery state has already been committed above.
      console.error(
        `[PrismaDeliveryRepository] Failed to append attempt log for ${deliveryId}#${attempts}: ${message}`,
      );
    }
  }
}
