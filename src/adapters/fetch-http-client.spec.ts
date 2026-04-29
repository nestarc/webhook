import { FetchHttpClient } from './fetch-http-client';
import {
  DEFAULT_USER_AGENT,
  RESPONSE_BODY_MAX_LENGTH,
} from '../webhook.constants';

describe('FetchHttpClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('uses the shared response body limit and default user agent', async () => {
    const responseBody = 'x'.repeat(RESPONSE_BODY_MAX_LENGTH + 1);
    const fetchMock = jest.fn().mockResolvedValue({
      status: 200,
      text: jest.fn().mockResolvedValue(responseBody),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new FetchHttpClient();

    const result = await client.post(
      'https://example.com/hook',
      { 'x-custom': '1' },
      '{}',
      1000,
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        'User-Agent': DEFAULT_USER_AGENT,
        'x-custom': '1',
      }),
    );
    expect(result.body).toHaveLength(RESPONSE_BODY_MAX_LENGTH);
  });
});
