import * as dns from 'dns';
import { WebhookDispatcher } from './webhook.dispatcher';
import { WebhookSigner } from './webhook.signer';
import { WebhookHttpClient } from './ports/webhook-http-client';
import { PendingDelivery } from './ports/webhook-delivery.repository';
import { WebhookUrlValidationError } from './webhook.url-validator';

function makeDelivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: 'd-1', eventId: 'evt-1', endpointId: 'ep-1', tenantId: null,
    attempts: 0, maxAttempts: 3,
    url: 'https://example.com/hook',
    secret: Buffer.from('a'.repeat(32)).toString('base64'),
    additionalSecrets: [],
    eventType: 'order.created',
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

  afterEach(() => {
    jest.restoreAllMocks();
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

  it('should include multiple signatures when additional secrets are provided', async () => {
    httpClient.post.mockResolvedValueOnce({
      success: true,
      statusCode: 200,
      body: 'OK',
      latencyMs: 50,
    });

    const delivery = makeDelivery({
      additionalSecrets: [Buffer.from('b'.repeat(32)).toString('base64')],
    });
    await dispatcher.dispatch(delivery);

    const [, headers] = httpClient.post.mock.calls[0];
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
  });

  it('should report malformed delivery URLs as URL validation errors even when private URLs are allowed', async () => {
    const permissiveDispatcher = new WebhookDispatcher(
      signer,
      httpClient,
      { allowPrivateUrls: true },
    );

    await expect(
      permissiveDispatcher.dispatch(makeDelivery({ url: 'not a url' })),
    ).rejects.toMatchObject({
      reason: 'parse',
      url: 'not a url',
    });
    await expect(
      permissiveDispatcher.dispatch(makeDelivery({ url: 'not a url' })),
    ).rejects.toBeInstanceOf(WebhookUrlValidationError);
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('should include the delivery URL on dispatch-time DNS validation errors', async () => {
    jest.spyOn(dns.promises, 'resolve4').mockResolvedValueOnce(['10.0.0.1']);
    jest.spyOn(dns.promises, 'resolve6').mockResolvedValueOnce([]);

    const url = 'http://customer.example/hook';
    await expect(
      dispatcher.dispatch(makeDelivery({ url })),
    ).rejects.toMatchObject({
      reason: 'private',
      url,
      resolvedIp: '10.0.0.1',
    });
    expect(httpClient.post).not.toHaveBeenCalled();
  });
});
