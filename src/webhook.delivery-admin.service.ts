import { Inject, Injectable } from '@nestjs/common';
import { WEBHOOK_DELIVERY_REPOSITORY } from './webhook.constants';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';
import {
  DeliveryLogFilters,
  DeliveryRecord,
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

  async retryDelivery(deliveryId: string): Promise<boolean> {
    return this.deliveryRepo.retryDelivery(deliveryId);
  }
}
