import { Inject, Injectable, Logger } from '@nestjs/common';
import { WebhookEvent } from './webhook.event';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_EVENT_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookEventRepository } from './ports/webhook-event.repository';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly maxAttempts: number;

  constructor(
    @Inject(WEBHOOK_EVENT_REPOSITORY)
    private readonly eventRepo: WebhookEventRepository,
    @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
    private readonly endpointRepo: WebhookEndpointRepository,
    @Inject(WEBHOOK_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: WebhookDeliveryRepository,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
  ) {
    this.maxAttempts = options.delivery?.maxRetries ?? 5;
  }

  async send(event: WebhookEvent): Promise<string> {
    return this.sendInternal(event, undefined);
  }

  async sendToTenant(tenantId: string, event: WebhookEvent): Promise<string> {
    return this.sendInternal(event, tenantId);
  }

  async sendToEndpoints(
    endpointIds: string[],
    event: WebhookEvent,
    tenantId?: string,
  ): Promise<string> {
    const payload = event.toPayload();
    const eventType = event.eventType;

    return this.deliveryRepo.runInTransaction(async (tx) => {
      const eventId = await this.eventRepo.saveEventInTransaction(
        tx,
        eventType,
        payload,
        tenantId ?? null,
      );

      if (endpointIds.length === 0) {
        this.logger.debug(
          `No endpoint IDs provided for event ${eventType} (eventId=${eventId})`,
        );
        return eventId;
      }

      await this.deliveryRepo.createDeliveriesInTransaction(
        tx,
        eventId,
        endpointIds,
        this.maxAttempts,
      );

      this.logger.log(
        `Event ${eventType} (${eventId}) → ${endpointIds.length} targeted endpoint(s)`,
      );

      return eventId;
    });
  }

  private async sendInternal(
    event: WebhookEvent,
    tenantId: string | undefined,
  ): Promise<string> {
    const payload = event.toPayload();
    const eventType = event.eventType;

    return this.deliveryRepo.runInTransaction(async (tx) => {
      const eventId = await this.eventRepo.saveEventInTransaction(
        tx,
        eventType,
        payload,
        tenantId ?? null,
      );

      const endpoints =
        await this.endpointRepo.findMatchingEndpointsInTransaction(
          tx,
          eventType,
          tenantId,
        );

      if (endpoints.length === 0) {
        this.logger.debug(
          `No matching endpoints for event ${eventType} (eventId=${eventId})`,
        );
        return eventId;
      }

      const endpointIds = endpoints.map((ep) => ep.id);
      await this.deliveryRepo.createDeliveriesInTransaction(
        tx,
        eventId,
        endpointIds,
        this.maxAttempts,
      );

      this.logger.log(
        `Event ${eventType} (${eventId}) → ${endpoints.length} endpoint(s)`,
      );

      return eventId;
    });
  }
}
