import { Injectable } from '@nestjs/common';
import { WebhookHttpClient } from '../ports/webhook-http-client';
import { DeliveryResult } from '../interfaces/webhook-delivery.interface';
import { RESPONSE_BODY_MAX_LENGTH } from '../webhook.constants';

@Injectable()
export class FetchHttpClient implements WebhookHttpClient {
  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeout: number,
  ): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    const start = Date.now();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': '@nestarc/webhook',
          ...headers,
        },
        body,
        signal: controller.signal,
        redirect: 'manual',
      });

      const latencyMs = Date.now() - start;
      const responseBody = await response.text();

      return {
        success: response.status >= 200 && response.status < 300,
        statusCode: response.status,
        body: responseBody.slice(0, RESPONSE_BODY_MAX_LENGTH),
        latencyMs,
      };
    } catch (error: unknown) {
      const latencyMs = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        latencyMs,
        error: message,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
