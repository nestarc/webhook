import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
  ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';

interface DeliveryEndpointMeta {
  tenantId: string | null;
  url: string;
}

@Injectable()
export class WebhookCircuitBreaker {
  private readonly logger = new Logger(WebhookCircuitBreaker.name);
  private readonly failureThreshold: number;
  private readonly degradedThreshold: number | undefined;
  private readonly cooldownMinutes: number;

  constructor(
    @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
    private readonly endpointRepo: WebhookEndpointRepository,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    private readonly options: WebhookModuleOptions,
  ) {
    this.failureThreshold =
      options.circuitBreaker?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.degradedThreshold = options.circuitBreaker?.degradedThreshold;
    this.cooldownMinutes =
      options.circuitBreaker?.cooldownMinutes ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES;
  }

  async afterDelivery(
    endpointId: string,
    success: boolean,
    meta: DeliveryEndpointMeta,
  ): Promise<void> {
    if (success) {
      await this.endpointRepo.resetFailures(endpointId);
      return;
    }

    const failures = await this.endpointRepo.incrementFailures(endpointId);
    await this.maybeFireEndpointDegradedHook(endpointId, failures, meta);

    if (failures >= this.failureThreshold) {
      const disabled = await this.endpointRepo.disableEndpoint(
        endpointId,
        ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
      );
      if (!disabled) return;

      this.logger.warn(
        `Endpoint ${endpointId} disabled: ${ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED} (threshold=${this.failureThreshold})`,
      );
      // Fire only on active->inactive transition to prevent duplicate notifications
      // and still notify if a prior disable attempt failed at the exact threshold.
      this.fireEndpointDisabledHook(endpointId, failures, meta);
    }
  }

  private async maybeFireEndpointDegradedHook(
    endpointId: string,
    failures: number,
    meta: DeliveryEndpointMeta,
  ): Promise<void> {
    const degradedThreshold = this.degradedThreshold;
    if (degradedThreshold === undefined) return;
    if (degradedThreshold >= this.failureThreshold) return;
    if (failures !== degradedThreshold) return;

    const endpoint = await this.endpointRepo.getEndpoint(endpointId);
    if (!endpoint?.active) return;

    this.fireEndpointDegradedHook(
      endpointId,
      failures,
      degradedThreshold,
      meta,
    );
  }

  private fireEndpointDegradedHook(
    endpointId: string,
    failures: number,
    degradedThreshold: number,
    meta: DeliveryEndpointMeta,
  ): void {
    if (!this.options.onEndpointDegraded) return;

    try {
      void Promise.resolve(
        this.options.onEndpointDegraded({
          endpointId,
          tenantId: meta.tenantId,
          url: meta.url,
          reason: 'consecutive_failures_degraded',
          consecutiveFailures: failures,
          degradedThreshold,
          failureThreshold: this.failureThreshold,
        }),
      ).catch((hookError) => {
        this.logError('onEndpointDegraded callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onEndpointDegraded callback error', hookError);
    }
  }

  private fireEndpointDisabledHook(
    endpointId: string,
    failures: number,
    meta: DeliveryEndpointMeta,
  ): void {
    if (!this.options.onEndpointDisabled) return;

    try {
      void Promise.resolve(
        this.options.onEndpointDisabled({
          endpointId,
          tenantId: meta.tenantId,
          url: meta.url,
          reason: ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
          consecutiveFailures: failures,
        }),
      ).catch((hookError) => {
        this.logError('onEndpointDisabled callback error', hookError);
      });
    } catch (hookError) {
      this.logError('onEndpointDisabled callback error', hookError);
    }
  }

  private logError(message: string, error: unknown): void {
    if (error instanceof Error) {
      this.logger.error(`${message}: ${error.message}`, error.stack);
      return;
    }
    this.logger.error(`${message}: ${String(error)}`);
  }

  async recoverEligibleEndpoints(): Promise<number> {
    const count = await this.endpointRepo.recoverEligibleEndpoints(
      this.cooldownMinutes,
    );
    if (count > 0) {
      this.logger.log(`Recovered ${count} endpoint(s) after cooldown`);
    }
    return count;
  }
}
