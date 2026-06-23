import { DeliveryResult } from '../interfaces/webhook-delivery.interface';

export interface WebhookHttpClientRequestOptions {
  /**
   * IP addresses already validated by the dispatcher. Built-in clients should
   * connect only to these addresses while preserving the original URL host.
   */
  resolvedIpAddresses?: string[];
}

export interface WebhookHttpClient {
  /**
   * @param timeout milliseconds before the request is aborted.
   * @returns DeliveryResult with success false on timeout/network failure; implementations should not throw for HTTP failures.
   */
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeout: number,
    options?: WebhookHttpClientRequestOptions,
  ): Promise<DeliveryResult>;
}
