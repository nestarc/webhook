import { Inject, Injectable } from '@nestjs/common';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
} from './webhook.constants';
import { WebhookDeliveryRepository } from './ports/webhook-delivery.repository';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookRetentionPurgeResult } from './interfaces/webhook-delivery.interface';

const ZERO_PURGE_RESULT: WebhookRetentionPurgeResult = {
  eventsPurged: 0,
  deliveriesPurged: 0,
  attemptsPurged: 0,
};

@Injectable()
export class WebhookRetentionAdminService {
  constructor(
    @Inject(WEBHOOK_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: WebhookDeliveryRepository,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    private readonly options: WebhookModuleOptions,
  ) {}

  async purgeExpiredData(now?: Date): Promise<WebhookRetentionPurgeResult> {
    const retention = this.options.retention;

    if (
      retention?.eventPayloadRetentionDays == null &&
      retention?.deliveryResponseBodyRetentionDays == null &&
      retention?.attemptResponseBodyRetentionDays == null
    ) {
      return ZERO_PURGE_RESULT;
    }

    if (!this.deliveryRepo.purgeExpiredData) {
      throw new Error(
        'WebhookDeliveryRepository does not support retention purge',
      );
    }

    return this.deliveryRepo.purgeExpiredData(retention, now);
  }
}
