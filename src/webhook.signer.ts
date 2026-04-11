import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';

export interface SignatureHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

@Injectable()
export class WebhookSigner {
  sign(
    eventId: string,
    timestamp: number,
    body: string,
    secret: string,
  ): SignatureHeaders {
    const toSign = `${eventId}.${timestamp}.${body}`;
    const hmac = crypto
      .createHmac('sha256', Buffer.from(secret, 'base64'))
      .update(toSign)
      .digest('base64');

    return {
      'webhook-id': eventId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${hmac}`,
    };
  }

  verify(
    eventId: string,
    timestamp: number,
    body: string,
    secret: string,
    signature: string,
  ): boolean {
    const expected = this.sign(eventId, timestamp, body, secret);
    const expectedSig = expected['webhook-signature'];

    const a = Buffer.from(expectedSig);
    const b = Buffer.from(signature);

    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
  }

  generateSecret(): string {
    return crypto.randomBytes(32).toString('base64');
  }
}
