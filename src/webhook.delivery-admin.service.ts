import { Inject, Injectable } from '@nestjs/common';
import { WEBHOOK_DELIVERY_REPOSITORY } from './webhook.constants';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';
import {
  DeliveryAttemptRecord,
  DeliveryLogFilters,
  DeliveryRecord,
  ReplayEventOptions,
  ReplayEventResult,
  RetryDeliveryOptions,
  RetryFailedDeliveriesFilters,
  RetryFailedDeliveriesResult,
} from './interfaces/webhook-delivery.interface';

@Injectable()
export class WebhookDeliveryAdminService {
  constructor(
    @Inject(WEBHOOK_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: WebhookDeliveryRepository,
  ) {}

  async getDeliveryLogs(
    endpointId: string,
    filters?: DeliveryLogFilters,
  ): Promise<DeliveryRecord[]> {
    return this.deliveryRepo.getDeliveryLogs(endpointId, filters);
  }

  async getDeliveryAttempts(deliveryId: string): Promise<DeliveryAttemptRecord[]> {
    return this.deliveryRepo.getDeliveryAttempts(deliveryId);
  }

  async retryDelivery(
    deliveryId: string,
    options?: RetryDeliveryOptions,
  ): Promise<boolean> {
    return this.deliveryRepo.retryDelivery(deliveryId, options);
  }

  async retryFailedDeliveries(
    filters: RetryFailedDeliveriesFilters,
    options?: RetryDeliveryOptions,
  ): Promise<RetryFailedDeliveriesResult> {
    if (!this.deliveryRepo.retryFailedDeliveries) {
      throw new Error(
        'WebhookDeliveryRepository does not support bulk failed delivery retry',
      );
    }

    return this.deliveryRepo.retryFailedDeliveries(filters, options);
  }

  async replayEvent(
    eventId: string,
    options?: ReplayEventOptions,
  ): Promise<ReplayEventResult> {
    if (!this.deliveryRepo.replayEvent) {
      throw new Error('WebhookDeliveryRepository does not support event replay');
    }

    return this.deliveryRepo.replayEvent(eventId, options);
  }
}
