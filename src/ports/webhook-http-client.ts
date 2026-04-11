import { DeliveryResult } from '../interfaces/webhook-delivery.interface';

export interface WebhookHttpClient {
  post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeout: number,
  ): Promise<DeliveryResult>;
}
