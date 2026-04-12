import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookRetryPolicy } from './webhook.retry-policy';
import {
  WEBHOOK_DELIVERY_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
  DEFAULT_POLLING_BATCH_SIZE,
  DEFAULT_STALE_SENDING_MINUTES,
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
  private readonly staleSendingMinutes: number;
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
    private readonly options: WebhookModuleOptions,
  ) {
    this.batchSize = options.polling?.batchSize ?? DEFAULT_POLLING_BATCH_SIZE;
    this.staleSendingMinutes =
      options.polling?.staleSendingMinutes ?? DEFAULT_STALE_SENDING_MINUTES;
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;
    if (this.isPolling) return;

    this.isPolling = true;
    try {
      await this.circuitBreaker.recoverEligibleEndpoints();

      // Recover deliveries stuck in SENDING from crashed workers
      const recovered = await this.deliveryRepo.recoverStaleSending(
        this.staleSendingMinutes,
      );
      if (recovered > 0) {
        this.logger.warn(`Recovered ${recovered} stale SENDING deliveries`);
      }

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

      // Persist delivery state — if this fails, catch resets to PENDING (safe)
      if (result.success) {
        await this.deliveryRepo.markSent(delivery.id, newAttempts, result);
      } else if (newAttempts >= delivery.max_attempts) {
        await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
        this.logger.warn(
          `Delivery ${delivery.id} exhausted retries (${newAttempts}/${delivery.max_attempts})`,
        );
        this.fireDeliveryFailedHook(delivery, newAttempts, result.error ?? null, result.statusCode ?? null);
      } else {
        const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
        await this.deliveryRepo.markRetry(
          delivery.id,
          newAttempts,
          nextAt,
          result,
        );
      }

      // Circuit breaker — failure here must NOT revert delivery state
      try {
        await this.circuitBreaker.afterDelivery(
          delivery.endpoint_id,
          result.success,
          { tenantId: delivery.tenant_id, url: delivery.url },
        );
      } catch (cbError) {
        this.logger.error(
          `Circuit breaker update failed for ${delivery.endpoint_id}: ${cbError}`,
        );
      }
    } catch (error) {
      this.logger.error(`Delivery ${delivery.id} processing error: ${error}`);
      // Increment attempts and apply backoff — never reset without accounting
      try {
        const newAttempts = delivery.attempts + 1;
        const errorResult = {
          success: false as const,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
        if (newAttempts >= delivery.max_attempts) {
          await this.deliveryRepo.markFailed(delivery.id, newAttempts, errorResult);
          this.logger.warn(
            `Delivery ${delivery.id} exhausted retries on exception (${newAttempts}/${delivery.max_attempts})`,
          );
          this.fireDeliveryFailedHook(delivery, newAttempts, errorResult.error ?? null, null);
        } else {
          const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
          await this.deliveryRepo.markRetry(delivery.id, newAttempts, nextAt, errorResult);
        }
      } catch (fallbackError) {
        this.logger.error(
          `Delivery ${delivery.id} fallback error handling failed: ${fallbackError}`,
        );
      }
    } finally {
      this.activeDeliveries--;
    }
  }

  private fireDeliveryFailedHook(
    delivery: PendingDelivery,
    attempts: number,
    lastError: string | null,
    responseStatus: number | null,
  ): void {
    if (!this.options.onDeliveryFailed) return;
    void Promise.resolve(
      this.options.onDeliveryFailed({
        deliveryId: delivery.id,
        endpointId: delivery.endpoint_id,
        eventId: delivery.event_id,
        tenantId: delivery.tenant_id,
        attempts,
        maxAttempts: delivery.max_attempts,
        lastError,
        responseStatus,
      }),
    ).catch((hookError) => {
      this.logger.error(`onDeliveryFailed callback error: ${hookError}`);
    });
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
