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
import {
  DeliveryFailureKind,
  WebhookModuleOptions,
} from './interfaces/webhook-options.interface';
import { DeliveryResult } from './interfaces/webhook-delivery.interface';
import {
  PendingDelivery,
  WebhookDeliveryRepository,
} from './ports/webhook-delivery.repository';
import { isRetryableDeliveryResult } from './webhook.retry-classifier';
import {
  WebhookUrlValidationError,
  WebhookUrlValidationReason,
} from './webhook.url-validator';

interface DeliveryFailureMeta {
  failureKind?: DeliveryFailureKind;
  validationReason?: WebhookUrlValidationReason;
  validationUrl?: string;
  resolvedIp?: string;
}

@Injectable()
export class WebhookDeliveryWorker implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private readonly batchSize: number;
  private readonly staleSendingMinutes: number;
  private isShuttingDown = false;
  private isPolling = false;
  private activePollCycle: Promise<void> | null = null;
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
    const pollCycle = this.runPollCycle();
    this.activePollCycle = pollCycle;
    try {
      await pollCycle;
    } finally {
      if (this.activePollCycle === pollCycle) {
        this.activePollCycle = null;
      }
      this.isPolling = false;
    }
  }

  private async runPollCycle(): Promise<void> {
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
      this.logError('Poll cycle failed', error);
    }
  }

  private async processDelivery(delivery: PendingDelivery): Promise<void> {
    this.activeDeliveries++;
    let dispatchReturned = false;

    try {
      const result = await this.dispatcher.dispatch(delivery);
      dispatchReturned = true;
      const newAttempts = delivery.attempts + 1;

      // Persist delivery state — if this fails, catch resets to PENDING (safe)
      const retryable = isRetryableDeliveryResult(result);

      if (result.success) {
        await this.deliveryRepo.markSent(delivery.id, newAttempts, result);
      } else if (!retryable) {
        await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
        this.logger.warn(
          `Delivery ${delivery.id} failed with non-retryable HTTP status ${result.statusCode} (${newAttempts}/${delivery.maxAttempts})`,
        );
        this.fireDeliveryFailedHook(
          delivery,
          newAttempts,
          result.error ?? null,
          result.statusCode ?? null,
          this.classifyResultFailure(result),
        );
      } else if (newAttempts >= delivery.maxAttempts) {
        await this.deliveryRepo.markFailed(delivery.id, newAttempts, result);
        this.logger.warn(
          `Delivery ${delivery.id} exhausted retries (${newAttempts}/${delivery.maxAttempts})`,
        );
        this.fireDeliveryFailedHook(
          delivery,
          newAttempts,
          result.error ?? null,
          result.statusCode ?? null,
          this.classifyResultFailure(result),
        );
      } else {
        const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
        await this.deliveryRepo.markRetry(
          delivery.id,
          newAttempts,
          nextAt,
          result,
        );
        this.fireDeliveryRetryScheduledHook(
          delivery,
          newAttempts,
          nextAt,
          result.error ?? null,
          result.statusCode ?? null,
          this.classifyResultFailure(result),
        );
      }

      // Circuit breaker — failure here must NOT revert delivery state
      await this.updateCircuitBreakerAfterDelivery(delivery, result.success);
    } catch (error) {
      this.logError(`Delivery ${delivery.id} processing error`, error);
      // Increment attempts and apply backoff — never reset without accounting
      try {
        const newAttempts = delivery.attempts + 1;
        const errorResult = {
          success: false as const,
          latencyMs: 0,
          error: error instanceof Error ? error.message : String(error),
        };
        const meta = this.classifyExceptionFailure(error, delivery);
        const dispatcherException = !dispatchReturned;

        if (newAttempts >= delivery.maxAttempts) {
          await this.deliveryRepo.markFailed(delivery.id, newAttempts, errorResult);
          this.logger.warn(
            `Delivery ${delivery.id} exhausted retries on exception (${newAttempts}/${delivery.maxAttempts})`,
          );
          this.fireDeliveryFailedHook(
            delivery,
            newAttempts,
            errorResult.error ?? null,
            null,
            meta,
          );
          if (dispatcherException) {
            await this.updateCircuitBreakerAfterDelivery(delivery, false);
          }
        } else {
          const nextAt = this.retryPolicy.nextAttemptAt(newAttempts);
          await this.deliveryRepo.markRetry(delivery.id, newAttempts, nextAt, errorResult);
          if (dispatcherException) {
            this.fireDeliveryRetryScheduledHook(
              delivery,
              newAttempts,
              nextAt,
              errorResult.error ?? null,
              null,
              meta,
            );
            await this.updateCircuitBreakerAfterDelivery(delivery, false);
          }
        }
      } catch (fallbackError) {
        this.logError(
          `Delivery ${delivery.id} fallback error handling failed`,
          fallbackError,
        );
      }
    } finally {
      this.activeDeliveries--;
    }
  }

  private async updateCircuitBreakerAfterDelivery(
    delivery: PendingDelivery,
    success: boolean,
  ): Promise<void> {
    try {
      await this.circuitBreaker.afterDelivery(
        delivery.endpointId,
        success,
        { tenantId: delivery.tenantId, url: delivery.url },
      );
    } catch (cbError) {
      this.logError(
        `Circuit breaker update failed for ${delivery.endpointId}`,
        cbError,
      );
    }
  }

  private fireDeliveryRetryScheduledHook(
    delivery: PendingDelivery,
    attempts: number,
    nextAttemptAt: Date,
    lastError: string | null,
    responseStatus: number | null,
    meta: DeliveryFailureMeta = {},
  ): void {
    if (!this.options.onDeliveryRetryScheduled) return;

    try {
      void Promise.resolve(
        this.options.onDeliveryRetryScheduled({
          deliveryId: delivery.id,
          endpointId: delivery.endpointId,
          eventId: delivery.eventId,
          tenantId: delivery.tenantId,
          attempts,
          maxAttempts: delivery.maxAttempts,
          nextAttemptAt,
          lastError,
          responseStatus,
          ...meta,
        }),
      ).catch((hookError) => {
        this.logError('onDeliveryRetryScheduled callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onDeliveryRetryScheduled callback error', hookError);
    }
  }

  private fireDeliveryFailedHook(
    delivery: PendingDelivery,
    attempts: number,
    lastError: string | null,
    responseStatus: number | null,
    meta: DeliveryFailureMeta = {},
  ): void {
    if (!this.options.onDeliveryFailed) return;

    try {
      void Promise.resolve(
        this.options.onDeliveryFailed({
          deliveryId: delivery.id,
          endpointId: delivery.endpointId,
          eventId: delivery.eventId,
          tenantId: delivery.tenantId,
          attempts,
          maxAttempts: delivery.maxAttempts,
          lastError,
          responseStatus,
          ...meta,
        }),
      ).catch((hookError) => {
        this.logError('onDeliveryFailed callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onDeliveryFailed callback error', hookError);
    }
  }

  private classifyExceptionFailure(
    error: unknown,
    delivery: PendingDelivery,
  ): DeliveryFailureMeta {
    if (error instanceof WebhookUrlValidationError) {
      return {
        failureKind: 'url_validation',
        validationReason: error.reason,
        validationUrl: error.url ?? delivery.url,
        resolvedIp: error.resolvedIp,
      };
    }

    return { failureKind: 'dispatch_error' };
  }

  private classifyResultFailure(result: DeliveryResult): DeliveryFailureMeta {
    return {
      failureKind: result.statusCode == null ? 'dispatch_error' : 'http_error',
    };
  }

  private logError(message: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(`${message}: ${error.message}`, error.stack);
      return;
    }
    this.logger.error(`${message}: ${String(error)}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('Shutting down delivery worker...');

    const deadline = Date.now() + 30_000;
    while (
      (this.activePollCycle || this.activeDeliveries > 0) &&
      Date.now() < deadline
    ) {
      await Promise.race([
        this.activePollCycle ?? new Promise((resolve) => setTimeout(resolve, 100)),
        new Promise((resolve) => setTimeout(resolve, 100)),
      ]);
    }

    if (this.activePollCycle || this.activeDeliveries > 0) {
      this.logger.warn(
        `Shutdown with ${this.activeDeliveries} active deliveries and an unfinished poll cycle`,
      );
    }
  }
}
