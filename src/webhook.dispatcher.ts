import { Inject, Injectable } from '@nestjs/common';
import { WebhookSigner } from './webhook.signer';
import { WEBHOOK_HTTP_CLIENT, WEBHOOK_MODULE_OPTIONS } from './webhook.constants';
import { DEFAULT_DELIVERY_TIMEOUT } from './webhook.constants';
import { WebhookModuleOptions } from './interfaces/webhook-options.interface';
import { WebhookHttpClient } from './ports/webhook-http-client';
import { DeliveryResult } from './interfaces/webhook-delivery.interface';
import { PendingDelivery } from './ports/webhook-delivery.repository';
import { resolveAndValidateHost } from './webhook.url-validator';

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
    // DNS rebinding defense — validate resolved IPs before every dispatch
    if (!this.allowPrivateUrls) {
      const hostname = new URL(delivery.url).hostname;
      await resolveAndValidateHost(hostname);
    }

    const body = JSON.stringify({
      type: delivery.event_type,
      data: delivery.payload,
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const headers = this.signer.signAll(
      delivery.event_id,
      timestamp,
      body,
      [delivery.secret, ...(delivery.additionalSecrets ?? [])],
    );

    return this.httpClient.post(delivery.url, headers, body, this.timeout);
  }
}
