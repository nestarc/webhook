import { Injectable } from '@nestjs/common';
import {
  PendingDelivery,
  WebhookDeliveryRepository,
} from '../ports/webhook-delivery.repository';
import {
  DeliveryLogFilters,
  DeliveryRecord,
  DeliveryResult,
} from '../interfaces/webhook-delivery.interface';

@Injectable()
export class PrismaDeliveryRepository implements WebhookDeliveryRepository {
  constructor(private readonly prisma: any) {}

  async createDeliveriesInTransaction(
    tx: any,
    eventId: string,
    endpointIds: string[],
    maxAttempts: number,
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO webhook_deliveries (event_id, endpoint_id, status, attempts, max_attempts, next_attempt_at)
       SELECT $1::uuid, unnest($2::uuid[]), 'PENDING', 0, $3, NOW()`,
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
      SET status = 'SENDING'
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
    return this.prisma.$queryRaw<PendingDelivery[]>`
      SELECT
        d.id, d.event_id, d.endpoint_id, d.attempts, d.max_attempts,
        e.url, e.secret,
        ev.event_type, ev.payload
      FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
      JOIN webhook_events ev ON ev.id = d.event_id
      WHERE d.id = ANY(${deliveryIds}::uuid[])`;
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
  }

  async resetToPending(deliveryId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'PENDING'
      WHERE id = ${deliveryId}::uuid`;
  }

  async recoverStaleSending(stalenessMinutes: number): Promise<number> {
    const interval = `${stalenessMinutes} minutes`;
    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE webhook_deliveries
      SET status = 'PENDING'
      WHERE status = 'SENDING'
        AND next_attempt_at + ${interval}::interval < NOW()
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
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.last_attempt_at DESC NULLS LAST
      LIMIT $${paramIndex++}
      OFFSET $${paramIndex}`;
    values.push(limit, offset);

    const results: DeliveryRecord[] = await this.prisma.$queryRawUnsafe(query, ...values);
    return results;
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
      INSERT INTO webhook_deliveries (event_id, endpoint_id, status, max_attempts, next_attempt_at)
      VALUES (${eventId}::uuid, ${endpointId}::uuid, 'PENDING', 1, NOW())`;
  }
}
