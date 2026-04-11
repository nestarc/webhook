import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebhookSigner } from './webhook.signer';
import { WebhookCircuitBreaker } from './webhook.circuit-breaker';
import { WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  DEFAULT_DELIVERY_TIMEOUT,
  DEFAULT_JITTER_FACTOR,
  DEFAULT_POLLING_BATCH_SIZE,
  RESPONSE_BODY_MAX_LENGTH,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { DeliveryResult } from './interfaces/webhook-delivery.interface';

interface PendingDelivery {
  id: string;
  event_id: string;
  endpoint_id: string;
  attempts: number;
  max_attempts: number;
  // joined from endpoint
  url: string;
  secret: string;
  // joined from event
  event_type: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class WebhookDeliveryWorker implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryWorker.name);
  private readonly prisma: any;
  private readonly timeout: number;
  private readonly batchSize: number;
  private readonly jitter: boolean;
  private isShuttingDown = false;
  private isPolling = false;
  private activeDeliveries = 0;

  constructor(
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
    private readonly signer: WebhookSigner,
    private readonly circuitBreaker: WebhookCircuitBreaker,
  ) {
    this.prisma = options.prisma;
    this.timeout = options.delivery?.timeout ?? DEFAULT_DELIVERY_TIMEOUT;
    this.batchSize = options.polling?.batchSize ?? DEFAULT_POLLING_BATCH_SIZE;
    this.jitter = options.delivery?.jitter ?? true;
  }

  async poll(): Promise<void> {
    if (this.isShuttingDown) return;
    if (this.isPolling) return;

    this.isPolling = true;
    try {
      // Always attempt to recover disabled endpoints, regardless of pending deliveries
      await this.circuitBreaker.recoverEligibleEndpoints();

      // Claim pending deliveries with FOR UPDATE SKIP LOCKED
      const deliveries = await this.prisma.$queryRaw<PendingDelivery[]>`
        UPDATE webhook_deliveries
        SET status = 'SENDING'
        WHERE id IN (
          SELECT d.id
          FROM webhook_deliveries d
          WHERE d.status = 'PENDING'
            AND d.next_attempt_at <= NOW()
          ORDER BY d.next_attempt_at ASC
          LIMIT ${this.batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          webhook_deliveries.id,
          webhook_deliveries.event_id,
          webhook_deliveries.endpoint_id,
          webhook_deliveries.attempts,
          webhook_deliveries.max_attempts`;

      if (deliveries.length === 0) return;

      // Fetch endpoint + event data for all deliveries
      const enriched = await this.enrichDeliveries(deliveries);

      // Process in parallel
      await Promise.all(
        enriched.map((delivery) => this.processDelivery(delivery)),
      );
    } catch (error) {
      this.logger.error(`Poll cycle failed: ${error}`);
    } finally {
      this.isPolling = false;
    }
  }

  private async enrichDeliveries(
    deliveries: PendingDelivery[],
  ): Promise<PendingDelivery[]> {
    const deliveryIds = deliveries.map((d) => d.id);

    return this.prisma.$queryRaw<PendingDelivery[]>`
      SELECT
        d.id, d.event_id, d.endpoint_id, d.attempts, d.max_attempts,
        e.url, e.secret,
        ev.event_type, ev.payload
      FROM webhook_deliveries d
      JOIN webhook_endpoints e ON e.id = d.endpoint_id
      JOIN webhook_events ev ON ev.id = d.event_id
      WHERE d.id = ANY(${deliveryIds}::uuid[])`;
  }

  private async processDelivery(delivery: PendingDelivery): Promise<void> {
    this.activeDeliveries++;

    try {
      const result = await this.deliver(delivery);
      const newAttempts = delivery.attempts + 1;

      if (result.success) {
        await this.markSent(delivery.id, newAttempts, result);
        await this.circuitBreaker.afterDelivery(delivery.endpoint_id, true);
      } else if (newAttempts >= delivery.max_attempts) {
        await this.markFailed(delivery.id, newAttempts, result);
        await this.circuitBreaker.afterDelivery(delivery.endpoint_id, false);
        this.logger.warn(
          `Delivery ${delivery.id} exhausted retries (${newAttempts}/${delivery.max_attempts})`,
        );
      } else {
        const nextAt = this.calculateNextAttempt(newAttempts);
        await this.markRetry(delivery.id, newAttempts, nextAt, result);
        await this.circuitBreaker.afterDelivery(delivery.endpoint_id, false);
      }
    } catch (error) {
      this.logger.error(`Delivery ${delivery.id} processing error: ${error}`);
      // Reset to PENDING so it can be retried
      await this.prisma.$executeRaw`
        UPDATE webhook_deliveries
        SET status = 'PENDING', updated_at = NOW()
        WHERE id = ${delivery.id}::uuid`;
    } finally {
      this.activeDeliveries--;
    }
  }

  private async deliver(delivery: PendingDelivery): Promise<DeliveryResult> {
    const body = JSON.stringify({
      type: delivery.event_type,
      data: delivery.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const headers = this.signer.sign(
      delivery.event_id,
      timestamp,
      body,
      delivery.secret,
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);
    const start = Date.now();

    try {
      const response = await fetch(delivery.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': '@nestarc/webhook',
          ...headers,
        },
        body,
        signal: controller.signal,
      });

      const latencyMs = Date.now() - start;
      const responseBody = await response.text();

      return {
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        body: responseBody.slice(0, RESPONSE_BODY_MAX_LENGTH),
        latencyMs,
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - start;
      const message =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        latencyMs,
        error: message,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private calculateNextAttempt(attempt: number): Date {
    const delay =
      DEFAULT_BACKOFF_SCHEDULE[
        Math.min(attempt - 1, DEFAULT_BACKOFF_SCHEDULE.length - 1)
      ];
    const jitter = this.jitter
      ? Math.random() * delay * DEFAULT_JITTER_FACTOR
      : 0;
    return new Date(Date.now() + (delay + jitter) * 1000);
  }

  private async markSent(
    deliveryId: string,
    attempts: number,
    result: DeliveryResult,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'SENT',
          attempts = ${attempts},
          last_attempt_at = NOW(),
          completed_at = NOW(),
          response_status = ${result.statusCode ?? null},
          response_body = ${result.body ?? null},
          latency_ms = ${result.latencyMs}
      WHERE id = ${deliveryId}::uuid`;
  }

  private async markFailed(
    deliveryId: string,
    attempts: number,
    result: DeliveryResult,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'FAILED',
          attempts = ${attempts},
          last_attempt_at = NOW(),
          completed_at = NOW(),
          response_status = ${result.statusCode ?? null},
          response_body = ${result.body ?? null},
          latency_ms = ${result.latencyMs},
          last_error = ${result.error ?? null}
      WHERE id = ${deliveryId}::uuid`;
  }

  private async markRetry(
    deliveryId: string,
    attempts: number,
    nextAt: Date,
    result: DeliveryResult,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries
      SET status = 'PENDING',
          attempts = ${attempts},
          last_attempt_at = NOW(),
          next_attempt_at = ${nextAt},
          response_status = ${result.statusCode ?? null},
          response_body = ${result.body ?? null},
          latency_ms = ${result.latencyMs},
          last_error = ${result.error ?? null}
      WHERE id = ${deliveryId}::uuid`;
  }

  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;
    this.logger.log('Shutting down delivery worker...');

    // Wait for active deliveries to complete (max 30s)
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
