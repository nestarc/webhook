import { DeliveryResult } from './interfaces/webhook-delivery.interface';
import { isRetryableDeliveryResult } from './webhook.retry-classifier';

function failedHttp(statusCode: number): DeliveryResult {
  return {
    success: false,
    statusCode,
    body: 'receiver response',
    latencyMs: 10,
  };
}

describe('isRetryableDeliveryResult', () => {
  it.each([400, 401, 403, 404, 410, 422])(
    'treats permanent HTTP %i as non-retryable',
    (statusCode) => {
      expect(isRetryableDeliveryResult(failedHttp(statusCode))).toBe(false);
    },
  );

  it.each([302, 408, 409, 425, 429, 500, 502, 503, 504])(
    'treats transient HTTP %i as retryable',
    (statusCode) => {
      expect(isRetryableDeliveryResult(failedHttp(statusCode))).toBe(true);
    },
  );

  it('treats dispatch failures without an HTTP status as retryable', () => {
    expect(
      isRetryableDeliveryResult({
        success: false,
        latencyMs: 10,
        error: 'ECONNREFUSED',
      }),
    ).toBe(true);
  });

  it('does not retry successful deliveries', () => {
    expect(
      isRetryableDeliveryResult({
        success: true,
        statusCode: 204,
        latencyMs: 10,
      }),
    ).toBe(false);
  });
});
