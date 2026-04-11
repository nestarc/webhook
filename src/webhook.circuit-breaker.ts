import { Inject, Injectable, Logger } from '@nestjs/common';
import { WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import {
  DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES,
  DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';

@Injectable()
export class WebhookCircuitBreaker {
  private readonly logger = new Logger(WebhookCircuitBreaker.name);
  private readonly prisma: any;
  private readonly failureThreshold: number;
  private readonly cooldownMinutes: number;

  constructor(
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
  ) {
    this.prisma = options.prisma;
    this.failureThreshold =
      options.circuitBreaker?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.cooldownMinutes =
      options.circuitBreaker?.cooldownMinutes ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MINUTES;
  }

  async afterDelivery(endpointId: string, success: boolean): Promise<void> {
    if (success) {
      await this.resetFailures(endpointId);
    } else {
      await this.recordFailure(endpointId);
    }
  }

  private async resetFailures(endpointId: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_endpoints
      SET consecutive_failures = 0,
          active = true,
          disabled_at = NULL,
          disabled_reason = NULL,
          updated_at = NOW()
      WHERE id = ${endpointId}::uuid`;
  }

  private async recordFailure(endpointId: string): Promise<void> {
    const [updated] = await this.prisma.$queryRaw<
      { consecutive_failures: number }[]
    >`
      UPDATE webhook_endpoints
      SET consecutive_failures = consecutive_failures + 1,
          updated_at = NOW()
      WHERE id = ${endpointId}::uuid
      RETURNING consecutive_failures`;

    if (updated.consecutive_failures >= this.failureThreshold) {
      await this.disableEndpoint(endpointId, 'consecutive_failures_exceeded');
    }
  }

  private async disableEndpoint(
    endpointId: string,
    reason: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE webhook_endpoints
      SET active = false,
          disabled_at = NOW(),
          disabled_reason = ${reason},
          updated_at = NOW()
      WHERE id = ${endpointId}::uuid
        AND active = true`;

    this.logger.warn(
      `Endpoint ${endpointId} disabled: ${reason} (threshold=${this.failureThreshold})`,
    );
  }

  async recoverEligibleEndpoints(): Promise<number> {
    const cooldownInterval = `${this.cooldownMinutes} minutes`;

    const recovered = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE webhook_endpoints
      SET active = true,
          consecutive_failures = 0,
          disabled_at = NULL,
          disabled_reason = NULL,
          updated_at = NOW()
      WHERE active = false
        AND disabled_at IS NOT NULL
        AND disabled_at + ${cooldownInterval}::interval <= NOW()
      RETURNING id`;

    if (recovered.length > 0) {
      this.logger.log(
        `Recovered ${recovered.length} endpoint(s) after cooldown`,
      );
    }

    return recovered.length;
  }
}
