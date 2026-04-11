import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookRetryPolicy } from './webhook.retry-policy';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
  DEFAULT_POLLING_BATCH_SIZE,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import {
  PendingDelivery,
  WebhookDeliveryRepository,
} from './ports/webhook-delivery.repository';

@Injectable()
export class WebhookDeliveryWorker implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private readonly batchSize: number;
  private isShuttingDown = false;
  private isPolling = false;
  private activeDeliveries = 0;

  constructor(
    @Inject(WEBHOOK_DELIVERY_REPOSITORY)
    private readonly deliveryRepo: WebhookDeliveryRepository,
    private readonly dispatcher: WebhookDispatcher,
    private readonly retryPolicy: WebhookRetryPolicy,
    private readonly circuitBreaker: WebhookCircuitBreaker,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
  ) {
    this.batchSize = options.polling?.batchSize ?? DEFAULT_POLLING_BATCH_SIZE;
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;
    if (this.isPolling) return;

    this.isPolling = true;
    try {
      await this.circuitBreaker.recoverEligibleEndpoints();

      const claimed = await this.deliveryRepo.claimPendingDeliveries(
        this.batchSize,
      );
      if (claimed.length === 0) return;

      const deliveries = await this.deliveryRepo.enrichDeliveries(
        claimed.map((d) => d.id),
      );

      await Promise.all(
        deliveries.map((delivery) => this.processDelivery(delivery)),
      );
    } catch (error) {
      this.logger.error(`Poll cycle failed: ${error}`);
    } finally {
      this.isPolling = false;
    }
  }

  private async processDelivery(delivery: PendingDelivery): Promise<void> {
    this.activeDeliveries++;

    try {
      const result = await this.dispatcher.dispatch(delivery);
      const newAttempts = delivery.attempts + 1;

      if (result.success) {
        await this.deliveryRepo.markSent(delivery.id, newAttempts, result);
        await this.circuitBreaker.afterDelivery(delivery.endpoint_id, true);
      } else if (newAttempts >= delivery.max_attempts) {
        await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
        await this.circuitBreaker.afterDelivery(delivery.endpoint_id, false);
        this.logger.warn(
          `Delivery ${delivery.id} exhausted retries (${newAttempts}/${delivery.max_attempts})`,
        );
      } else {
        const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
        await this.deliveryRepo.markRetry(
          delivery.id,
          newAttempts,
          nextAt,
          result,
        );
        await this.circuitBreaker.afterDelivery(delivery.endpoint_id, false);
      }
    } catch (error) {
      this.logger.error(`Delivery ${delivery.id} processing error: ${error}`);
      await this.deliveryRepo.resetToPending(delivery.id);
    } finally {
      this.activeDeliveries--;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('Shutting down delivery worker...');

    const deadline = Date.now() + 30_000;
    while (this.activeDeliveries > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (this.activeDeliveries > 0) {
      this.logger.warn(
        `Shutdown with ${this.activeDeliveries} active deliveries`,
      );
    }
  }
}
