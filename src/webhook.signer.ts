import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';

export interface SignatureHeaders {
  [key: string]: string;
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export interface WebhookVerificationOptions {
  toleranceSeconds: number;
  now?: Date;
}

@Injectable()
export class WebhookSigner {
  signAll(
    eventId: string,
    timestamp: number,
    body: string,
    secrets: string[],
  ): SignatureHeaders {
    const signatures = secrets
      .filter((secret): secret is string => Boolean(secret))
      .map((secret) => this.signSingle(eventId, timestamp, body, secret));

    if (signatures.length === 0) {
      throw new Error('At least one signing secret is required');
    }

    return {
      'webhook-id': eventId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signatures.join(' '),
    };
  }

  sign(
    eventId: string,
    timestamp: number,
    body: string,
    secret: string,
  ): SignatureHeaders {
    return this.signAll(eventId, timestamp, body, [secret]);
  }

  verify(
    eventId: string,
    timestamp: number,
    body: string,
    secret: string,
    signature: string,
  ): boolean {
    const expected = this.signSingle(eventId, timestamp, body, secret);
    const providedSignatures = signature.trim().split(/\s+/).filter(Boolean);

    return providedSignatures.some((candidate) => {
      const a = Buffer.from(expected);
      const b = Buffer.from(candidate);

      if (a.length !== b.length) return false;

      return crypto.timingSafeEqual(a, b);
    });
  }

  verifyWithTolerance(
    eventId: string,
    timestamp: number,
    body: string,
    secret: string,
    signature: string,
    options: WebhookVerificationOptions,
  ): boolean {
    if (
      !Number.isFinite(options.toleranceSeconds) ||
      options.toleranceSeconds < 0
    ) {
      throw new Error('toleranceSeconds must be a finite non-negative number');
    }

    if (!Number.isFinite(timestamp)) {
      return false;
    }

    const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowSeconds - timestamp) > options.toleranceSeconds) {
      return false;
    }

    return this.verify(eventId, timestamp, body, secret, signature);
  }

  generateSecret(): string {
    return crypto.randomBytes(32).toString('base64');
  }

  private signSingle(
    eventId: string,
    timestamp: number,
    body: string,
    secret: string,
  ): string {
    const toSign = `${eventId}.${timestamp}.${body}`;
    const hmac = crypto
      .createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(toSign)
      .digest('base64');

    return `v1,${hmac}`;
  }
}
