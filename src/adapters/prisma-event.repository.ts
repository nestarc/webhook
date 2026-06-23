import { Injectable } from '@nestjs/common';
import {
  SavedWebhookEvent,
  WebhookEventRepository,
} from '../ports/webhook-event.repository';
import { WebhookPublishOptions } from '../interfaces/webhook-options.interface';

@Injectable()
export class PrismaEventRepository implements WebhookEventRepository {
  constructor(private readonly prisma: any) {}

  async saveEvent(
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
  ): Promise<string> {
    const [saved] = await this.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_events (event_type, payload, tenant_id)
      VALUES (${eventType}, ${JSON.stringify(payload)}::jsonb, ${tenantId})
      RETURNING id`;
    return saved.id;
  }

  async saveEventInTransaction(
    tx: any,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
  ): Promise<string> {
    const [saved] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO webhook_events (event_type, payload, tenant_id)
      VALUES (${eventType}, ${JSON.stringify(payload)}::jsonb, ${tenantId})
      RETURNING id`;
    return saved.id;
  }

  async saveEventOnceInTransaction(
    tx: any,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
    options: Required<Pick<WebhookPublishOptions, 'idempotencyKey'>> &
      Pick<WebhookPublishOptions, 'correlationId'>,
  ): Promise<SavedWebhookEvent> {
    const [saved] = await tx.$queryRaw<SavedWebhookEvent[]>`
      WITH inserted AS (
        INSERT INTO webhook_events (
          event_type,
          payload,
          tenant_id,
          idempotency_key,
          correlation_id
        )
        VALUES (
          ${eventType},
          ${JSON.stringify(payload)}::jsonb,
          ${tenantId},
          ${options.idempotencyKey},
          ${options.correlationId ?? null}
        )
        ON CONFLICT DO NOTHING
        RETURNING id, TRUE AS created
      )
      SELECT id, created FROM inserted
      UNION ALL
      SELECT id, FALSE AS created
      FROM webhook_events
      WHERE COALESCE(tenant_id, '') = COALESCE(${tenantId}, '')
        AND event_type = ${eventType}
        AND idempotency_key = ${options.idempotencyKey}
        AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1`;

    if (!saved) {
      throw new Error('Failed to save idempotent webhook event');
    }

    return saved;
  }
}
