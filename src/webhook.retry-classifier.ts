import { DeliveryResult } from './interfaces/webhook-delivery.interface';

const RETRYABLE_CLIENT_ERROR_STATUSES = new Set([408, 409, 425, 429]);

export function isRetryableDeliveryResult(result: DeliveryResult): boolean {
  if (result.success) {
    return false;
  }

  if (result.statusCode == null) {
    return true;
  }

  if (result.statusCode >= 400 && result.statusCode < 500) {
    return RETRYABLE_CLIENT_ERROR_STATUSES.has(result.statusCode);
  }

  return true;
}
