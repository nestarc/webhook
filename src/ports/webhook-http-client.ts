import { DeliveryResult } from '../interfaces/webhook-delivery.interface';

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
  ): Promise<DeliveryResult>;
}
