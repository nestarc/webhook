import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  WEBHOOK_ENDPOINT_REPOSITORY,
  WEBHOOK_MODULE_OPTIONS,
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookEndpointRepository } from './ports/webhook-endpoint.repository';

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
    meta?: { tenantId: string; url: string },
  ): Promise<void> {
    if (success) {
      await this.endpointRepo.resetFailures(endpointId);
    } else {
      const failures = await this.endpointRepo.incrementFailures(endpointId);
      if (failures >= this.failureThreshold) {
        await this.endpointRepo.disableEndpoint(
          endpointId,
          'consecutive_failures_exceeded',
        );
        this.logger.warn(
          `Endpoint ${endpointId} disabled: consecutive_failures_exceeded (threshold=${this.failureThreshold})`,
        );
        if (this.options.onEndpointDisabled) {
          try {
            await this.options.onEndpointDisabled({
              endpointId,
              tenantId: meta?.tenantId ?? '',
              url: meta?.url ?? '',
              reason: 'consecutive_failures_exceeded',
              consecutiveFailures: this.failureThreshold,
            });
          } catch (hookError) {
            this.logger.error(`onEndpointDisabled callback error: ${hookError}`);
          }
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
