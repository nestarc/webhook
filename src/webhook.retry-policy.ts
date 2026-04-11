import { Inject, Injectable } from '@nestjs/common';
import { WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import {
  DEFAULT_BACKOFF_SCHEDULE,
  DEFAULT_JITTER_FACTOR,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';

@Injectable()
export class WebhookRetryPolicy {
  private readonly jitter: boolean;

  constructor(
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
  ) {
    this.jitter = options.delivery?.jitter ?? true;
  }

  nextAttemptAt(attempt: number): Date {
    const delay =
      DEFAULT_BACKOFF_SCHEDULE[
        Math.min(attempt - 1, DEFAULT_BACKOFF_SCHEDULE.length - 1)
      ];
    const jitterOffset = this.jitter
      ? Math.random() * delay * DEFAULT_JITTER_FACTOR
      : 0;
    return new Date(Date.now() + (delay + jitterOffset) * 1000);
  }
}
