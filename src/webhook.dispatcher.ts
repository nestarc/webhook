import { Inject, Injectable } from '@nestjs/common';
import { WebhookSigner } from './webhook.signer';
import {
  WEBHOOK_HTTP_CLIENT,
  WEBHOOK_MODULE_OPTIONS,
  DEFAULT_DELIVERY_TIMEOUT,
} from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookHttpClient } from './ports/webhook-http-client';
import { DeliveryResult } from './interfaces/webhook-delivery.interface';
import { PendingDelivery } from './ports/webhook-delivery.repository';
import {
  resolveAndValidateHost,
  WebhookUrlValidationError,
} from './webhook.url-validator';

@Injectable()
export class WebhookDispatcher {
  private readonly timeout: number;
  private readonly allowPrivateUrls: boolean;

  constructor(
    private readonly signer: WebhookSigner,
    @Inject(WEBHOOK_HTTP_CLIENT)
    private readonly httpClient: WebhookHttpClient,
    @Inject(WEBHOOK_MODULE_OPTIONS)
    options: WebhookModuleOptions,
  ) {
    this.timeout = options.delivery?.timeout ?? DEFAULT_DELIVERY_TIMEOUT;
    this.allowPrivateUrls = options.allowPrivateUrls ?? false;
  }

  async dispatch(delivery: PendingDelivery): Promise<DeliveryResult> {
    const parsedUrl = this.parseDeliveryUrl(delivery.url);

    // DNS rebinding defense — validate resolved IPs before every dispatch
    if (!this.allowPrivateUrls) {
      await resolveAndValidateHost(parsedUrl.hostname, delivery.url);
    }

    const body = JSON.stringify({
      type: delivery.eventType,
      data: delivery.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const headers = this.signer.signAll(
      delivery.eventId,
      timestamp,
      body,
      [delivery.secret, ...delivery.additionalSecrets],
    );

    return this.httpClient.post(delivery.url, headers, body, this.timeout);
  }

  private parseDeliveryUrl(url: string): URL {
    try {
      return new URL(url);
    } catch {
      throw new WebhookUrlValidationError(
        `Invalid webhook URL: unable to parse "${url}"`,
        'parse',
        url,
      );
    }
  }
}
