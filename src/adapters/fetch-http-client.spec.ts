import { FetchHttpClient } from './fetch-http-client';
import * as http from 'http';
import {
  DEFAULT_USER_AGENT,
  RESPONSE_BODY_MAX_LENGTH,
} from '../webhook.constants';

describe('FetchHttpClient', () => {
  it('uses the shared response body limit and default user agent', async () => {
    const responseBody = 'x'.repeat(RESPONSE_BODY_MAX_LENGTH + 1);
    let receivedHeaders: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((req, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(responseBody);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    const client = new FetchHttpClient();

    try {
      const result = await client.post(
        `http://127.0.0.1:${address.port}/hook`,
        { 'x-custom': '1' },
        '{}',
        1000,
      );

      expect(receivedHeaders).toEqual(
        expect.objectContaining({
          'content-type': 'application/json',
          'user-agent': DEFAULT_USER_AGENT,
          'x-custom': '1',
        }),
      );
      expect(result.body).toHaveLength(RESPONSE_BODY_MAX_LENGTH);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('can connect through a prevalidated pinned IP without resolving the URL host again', async () => {
    let receivedHost: string | undefined;
    const server = http.createServer((req, res) => {
      receivedHost = req.headers.host;
      res.writeHead(204);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    const client = new FetchHttpClient();

    try {
      const result = await (client.post as (
        url: string,
        headers: Record<string, string>,
        body: string,
        timeout: number,
        options?: { resolvedIpAddresses: string[] },
      ) => ReturnType<FetchHttpClient['post']>)(
        `http://rebind.test:${address.port}/hook`,
        {},
        '{}',
        1000,
        { resolvedIpAddresses: ['127.0.0.1'] },
      );

      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(204);
      expect(receivedHost).toBe(`rebind.test:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('stops reading receiver response bodies after the retention limit', async () => {
    let chunksWritten = 0;
    const totalChunks = 64;
    const chunk = 'x'.repeat(1024);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      const interval = setInterval(() => {
        chunksWritten += 1;
        res.write(chunk);
        if (chunksWritten >= totalChunks) {
          clearInterval(interval);
          res.end();
        }
      }, 5);
      res.on('close', () => clearInterval(interval));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address');
    }
    const client = new FetchHttpClient();

    try {
      const result = await client.post(
        `http://127.0.0.1:${address.port}/hook`,
        {},
        '{}',
        1000,
      );

      expect(result.body).toHaveLength(RESPONSE_BODY_MAX_LENGTH);
      expect(chunksWritten).toBeLessThan(totalChunks);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
