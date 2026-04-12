import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookSigner } from './webhook.signer';
import { WebhookHttpClient } from './ports/webhook-http-client';
import { PendingDelivery } from './ports/webhook-delivery.repository';

function makeDelivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: 'd-1', event_id: 'evt-1', endpoint_id: 'ep-1', tenant_id: null,
    attempts: 0, max_attempts: 3,
    url: 'https://example.com/hook',
    secret: Buffer.from('a'.repeat(32)).toString('base64'),
    event_type: 'order.created',
    payload: { orderId: 'ord-1' },
    ...overrides,
  };
}

describe('WebhookDispatcher', () => {
  let dispatcher: WebhookDispatcher;
  let signer: WebhookSigner;
  let httpClient: jest.Mocked<WebhookHttpClient>;

  beforeEach(() => {
    signer = new WebhookSigner();
    httpClient = { post: jest.fn() } as jest.Mocked<WebhookHttpClient>;
    dispatcher = new WebhookDispatcher(signer, httpClient, { delivery: { timeout: 5000 } });
  });

  it('should call httpClient.post with signed headers', async () => {
    httpClient.post.mockResolvedValueOnce({ success: true, statusCode: 200, body: 'OK', latencyMs: 50 });

    const delivery = makeDelivery();
    await dispatcher.dispatch(delivery);

    expect(httpClient.post).toHaveBeenCalledTimes(1);
    const [url, headers, body, timeout] = httpClient.post.mock.calls[0];
    expect(url).toBe('https://example.com/hook');
    expect(headers['webhook-id']).toBe('evt-1');
    expect(headers['webhook-signature']).toMatch(/^v1,.+$/);
    expect(headers['webhook-timestamp']).toBeDefined();
    expect(JSON.parse(body)).toEqual({ type: 'order.created', data: { orderId: 'ord-1' } });
    expect(timeout).toBe(5000);
  });

  it('should use default timeout when not configured', () => {
    const defaultDispatcher = new WebhookDispatcher(signer, httpClient, {});
    // Access private field to verify default
    expect((defaultDispatcher as any).timeout).toBe(10_000);
  });
});
