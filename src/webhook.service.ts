import { Inject, Injectable, Logger } from '@nestjs/common';
import { WebhookEvent } from './webhook.event';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_EVENT_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
} from './webhook.constants';
import {
  WebhookModuleOptions,
  WebhookPublishOptions,
  WebhookRedactionOptions,
} from './interfaces/webhook-options.interface';
import { WebhookEventRepository } from './ports/webhook-event.repository';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';
import {
  WebhookDeliveryRepository,
  WebhookTransaction,
} from './ports/webhook-delivery.repository';

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly maxAttempts: number;
  private readonly redaction?: WebhookRedactionOptions;

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
    this.redaction = options.redaction;
  }

  async send(event: WebhookEvent, options?: WebhookPublishOptions): Promise<string> {
    return this.sendInternal(event, undefined, options);
  }

  async sendToTenant(
    tenantId: string,
    event: WebhookEvent,
    options?: WebhookPublishOptions,
  ): Promise<string> {
    return this.sendInternal(event, tenantId, options);
  }

  async sendToEndpoints(
    endpointIds: string[],
    event: WebhookEvent,
    tenantIdOrOptions?: string | WebhookPublishOptions,
    options?: WebhookPublishOptions,
  ): Promise<string> {
    const tenantId =
      typeof tenantIdOrOptions === 'string' ? tenantIdOrOptions : undefined;
    const publishOptions =
      typeof tenantIdOrOptions === 'object' ? tenantIdOrOptions : options;
    const eventType = event.eventType;
    const payload = this.sanitizePayload(
      event.toPayload(),
      eventType,
      tenantId ?? null,
    );

    return this.deliveryRepo.runInTransaction(async (tx) => {
      const savedEvent = await this.saveEventInTransaction(
        tx,
        eventType,
        payload,
        tenantId ?? null,
        publishOptions,
      );
      const eventId = savedEvent.id;

      if (!savedEvent.created) {
        this.logger.debug(
          `Idempotent event ${eventType} (${eventId}) already exists; skipping targeted delivery creation`,
        );
        return eventId;
      }

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
    options?: WebhookPublishOptions,
  ): Promise<string> {
    const eventType = event.eventType;
    const payload = this.sanitizePayload(
      event.toPayload(),
      eventType,
      tenantId ?? null,
    );

    return this.deliveryRepo.runInTransaction(async (tx) => {
      const savedEvent = await this.saveEventInTransaction(
        tx,
        eventType,
        payload,
        tenantId ?? null,
        options,
      );
      const eventId = savedEvent.id;

      if (!savedEvent.created) {
        this.logger.debug(
          `Idempotent event ${eventType} (${eventId}) already exists; skipping delivery creation`,
        );
        return eventId;
      }

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

  private async saveEventInTransaction(
    tx: WebhookTransaction,
    eventType: string,
    payload: Record<string, unknown>,
    tenantId: string | null,
    options?: WebhookPublishOptions,
  ): Promise<{ id: string; created: boolean }> {
    if (!options?.idempotencyKey) {
      const id = await this.eventRepo.saveEventInTransaction(
        tx,
        eventType,
        payload,
        tenantId,
      );
      return { id, created: true };
    }

    if (!this.eventRepo.saveEventOnceInTransaction) {
      throw new Error(
        'WebhookEventRepository does not support idempotent event persistence',
      );
    }

    return this.eventRepo.saveEventOnceInTransaction(tx, eventType, payload, tenantId, {
      idempotencyKey: options.idempotencyKey,
      correlationId: options.correlationId,
    });
  }

  private sanitizePayload(
    payload: Record<string, unknown>,
    eventType: string,
    tenantId: string | null,
  ): Record<string, unknown> {
    return this.redaction?.sanitizePayload?.(payload, { eventType, tenantId }) ?? payload;
  }
}
