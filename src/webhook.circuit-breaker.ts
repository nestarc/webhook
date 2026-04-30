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
  private readonly cooldownMinutes: number;

  constructor(
    @Inject(WEBHOOK_ENDPOINT_REPOSITORY)
    private readonly endpointRepo: WebhookEndpointRepository,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    private readonly options: WebhookModuleOptions,
  ) {
    this.failureThreshold =
      options.circuitBreaker?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
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
    } else {
      const failures = await this.endpointRepo.incrementFailures(endpointId);
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
        if (this.options.onEndpointDisabled) {
          void Promise.resolve(
            this.options.onEndpointDisabled({
              endpointId,
              tenantId: meta.tenantId,
              url: meta.url,
              reason: ENDPOINT_DISABLED_REASON_CONSECUTIVE_FAILURES_EXCEEDED,
              consecutiveFailures: failures,
            }),
          ).catch((hookError) => {
            this.logger.error(`onEndpointDisabled callback error: ${hookError}`);
          });
        }
      }
    }
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
