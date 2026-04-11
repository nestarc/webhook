import { Inject, Injectable, Logger } from '@nestjs/common';
import { WebhookEvent } from './webhook.event';
import { WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { EndpointRecord } from './interfaces/webhook-endpoint.interface';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly prisma: any;

  constructor(
    @Inject(WEBHOOK_MODULE_OPTIONS)
    private readonly options: WebhookModuleOptions,
  ) {
    this.prisma = options.prisma;
  }

  async send(event: WebhookEvent): Promise<string> {
    return this.sendInternal(event, undefined);
  }

  async sendToTenant(tenantId: string, event: WebhookEvent): Promise<string> {
    return this.sendInternal(event, tenantId);
  }

  private async sendInternal(
    event: WebhookEvent,
    tenantId: string | undefined,
  ): Promise<string> {
    const payload = event.toPayload();
    const eventType = event.eventType;
    const maxAttempts = this.options.delivery?.maxRetries ?? 5;

    return this.prisma.$transaction(async (tx: any) => {
      // 1. Save event
      const [savedEvent] = await tx.$queryRaw<
        { id: string }[]
      >`INSERT INTO webhook_events (event_type, payload, tenant_id)
        VALUES (${eventType}, ${JSON.stringify(payload)}::jsonb, ${tenantId ?? null})
        RETURNING id`;

      const eventId = savedEvent.id;

      // 2. Find matching endpoints
      const endpoints = await this.findMatchingEndpoints(tx, eventType, tenantId);

      if (endpoints.length === 0) {
        this.logger.debug(
          `No matching endpoints for event ${eventType} (eventId=${eventId})`,
        );
        return eventId;
      }

      // 3. Batch create delivery records (parameterized)
      const endpointIds = endpoints.map((ep) => ep.id);
      await tx.$executeRawUnsafe(
        `INSERT INTO webhook_deliveries (event_id, endpoint_id, status, attempts, max_attempts, next_attempt_at)
         SELECT $1::uuid, unnest($2::uuid[]), 'PENDING', 0, $3, NOW()`,
        eventId,
        endpointIds,
        maxAttempts,
      );

      this.logger.log(
        `Event ${eventType} (${eventId}) → ${endpoints.length} endpoint(s)`,
      );

      return eventId;
    });
  }

  private async findMatchingEndpoints(
    tx: any,
    eventType: string,
    tenantId: string | undefined,
  ): Promise<EndpointRecord[]> {
    if (tenantId !== undefined) {
      return tx.$queryRaw<EndpointRecord[]>`
        SELECT * FROM webhook_endpoints
        WHERE active = true
          AND tenant_id = ${tenantId}
          AND (${eventType} = ANY(events) OR '*' = ANY(events))`;
    }

    return tx.$queryRaw<EndpointRecord[]>`
      SELECT * FROM webhook_endpoints
      WHERE active = true
        AND (${eventType} = ANY(events) OR '*' = ANY(events))`;
  }
}
