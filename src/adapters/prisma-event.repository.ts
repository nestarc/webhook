import { Injectable } from '@nestjs/common';
import { WebhookEventRepository } from '../ports/webhook-event.repository';

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
}
