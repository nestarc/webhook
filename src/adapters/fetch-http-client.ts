import { Injectable } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import {
  WebhookHttpClient,
  WebhookHttpClientRequestOptions,
} from '../ports/webhook-http-client';
import { DeliveryResult } from '../interfaces/webhook-delivery.interface';
import {
  DEFAULT_USER_AGENT,
  RESPONSE_BODY_MAX_LENGTH,
} from '../webhook.constants';

type PinnedAddress = {
  address: string;
  family: 4 | 6;
};

@Injectable()
export class FetchHttpClient implements WebhookHttpClient {
  async post(
    url: string,
    headers: Record<string, string>,
    body: string,
    timeout: number,
    options?: WebhookHttpClientRequestOptions,
  ): Promise<DeliveryResult> {
    const start = Date.now();

    return new Promise<DeliveryResult>((resolve) => {
      let settled = false;
      let timeoutId: NodeJS.Timeout | undefined;
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const transport = isHttps ? https : http;
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      const lookup = createPinnedLookup(options?.resolvedIpAddresses);

      const finish = (result: DeliveryResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        resolve(result);
      };

      const request = transport.request(
        {
          protocol: parsed.protocol,
          hostname,
          port: parsed.port,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
            ...headers,
          },
          lookup,
          servername: isHttps ? hostname : undefined,
        },
        (response) => {
          const latencyMs = Date.now() - start;
          readLimitedResponseBody(response)
            .then((responseBody) => {
              finish({
                success: response.statusCode !== undefined &&
                  response.statusCode >= 200 &&
                  response.statusCode < 300,
                statusCode: response.statusCode,
                body: responseBody,
                latencyMs,
              });
            })
            .catch((error: unknown) => {
              finish({
                success: false,
                latencyMs,
                error: error instanceof Error ? error.message : String(error),
              });
            });
        },
      );

      request.on('error', (error) => {
        finish({
          success: false,
          latencyMs: Date.now() - start,
          error: error.message,
        });
      });

      request.setTimeout(timeout, () => {
        request.destroy(new Error('Request timed out'));
      });
      timeoutId = setTimeout(() => {
        request.destroy(new Error('Request timed out'));
      }, timeout);

      request.write(body);
      request.end();
    });
  }
}

function createPinnedLookup(
  addresses?: string[],
): http.RequestOptions['lookup'] | undefined {
  const pinned = (addresses ?? [])
    .map((address): PinnedAddress | null => {
      const family = net.isIP(address);
      return family === 4 || family === 6 ? { address, family } : null;
    })
    .filter((address): address is PinnedAddress => address !== null);

  if (pinned.length === 0) {
    return undefined;
  }

  return (_hostname, lookupOptions, callback) => {
    const options = typeof lookupOptions === 'number'
      ? { family: lookupOptions, all: false }
      : lookupOptions;
    const family = options?.family === 4 || options?.family === 6
      ? options.family
      : undefined;
    const matches = family
      ? pinned.filter((address) => address.family === family)
      : pinned;

    if (matches.length === 0) {
      const error = new Error('No prevalidated address matches requested family') as
        NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', family ?? 0);
      return;
    }

    if (typeof options === 'object' && options.all) {
      callback(null, matches as never, 0);
      return;
    }

    callback(null, matches[0].address, matches[0].family);
  };
}

function readLimitedResponseBody(response: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let body = '';
    let settled = false;

    const finish = (result: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      if (settled) {
        return;
      }
      const remaining = RESPONSE_BODY_MAX_LENGTH - body.length;
      if (remaining > 0) {
        body += chunk.slice(0, remaining);
      }
      if (body.length >= RESPONSE_BODY_MAX_LENGTH) {
        finish(body);
        response.destroy();
      }
    });
    response.on('end', () => finish(body));
    response.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
