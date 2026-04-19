import { WebhookSigner } from './webhook.signer';

describe('WebhookSigner', () => {
  let signer: WebhookSigner;

  beforeEach(() => {
    signer = new WebhookSigner();
  });

  describe('sign', () => {
    it('should return Standard Webhooks compatible headers', () => {
      const secret = Buffer.from('test-secret').toString('base64');
      const headers = signer.sign('evt_123', 1712836800, '{"test":true}', secret);

      expect(headers['webhook-id']).toBe('evt_123');
      expect(headers['webhook-timestamp']).toBe('1712836800');
      expect(headers['webhook-signature']).toMatch(/^v1,.+$/);
    });

    it('should produce deterministic signatures', () => {
      const secret = Buffer.from('test-secret').toString('base64');
      const h1 = signer.sign('evt_1', 1000, 'body', secret);
      const h2 = signer.sign('evt_1', 1000, 'body', secret);

      expect(h1['webhook-signature']).toBe(h2['webhook-signature']);
    });

    it('should produce different signatures for different payloads', () => {
      const secret = Buffer.from('test-secret').toString('base64');
      const h1 = signer.sign('evt_1', 1000, 'body-a', secret);
      const h2 = signer.sign('evt_1', 1000, 'body-b', secret);

      expect(h1['webhook-signature']).not.toBe(h2['webhook-signature']);
    });

    it('should produce different signatures for different timestamps', () => {
      const secret = Buffer.from('test-secret').toString('base64');
      const h1 = signer.sign('evt_1', 1000, 'body', secret);
      const h2 = signer.sign('evt_1', 2000, 'body', secret);

      expect(h1['webhook-signature']).not.toBe(h2['webhook-signature']);
    });

    it('should produce different signatures for different secrets', () => {
      const s1 = Buffer.from('secret-a').toString('base64');
      const s2 = Buffer.from('secret-b').toString('base64');
      const h1 = signer.sign('evt_1', 1000, 'body', s1);
      const h2 = signer.sign('evt_1', 1000, 'body', s2);

      expect(h1['webhook-signature']).not.toBe(h2['webhook-signature']);
    });
  });

  describe('signAll', () => {
    it('should serialize multiple signatures as a space-delimited header', () => {
      const primary = Buffer.from('primary-secret').toString('base64');
      const secondary = Buffer.from('secondary-secret').toString('base64');

      const headers = signer.signAll('evt_123', 1712836800, '{"test":true}', [
        primary,
        secondary,
      ]);

      expect(headers['webhook-signature']).toMatch(/^v1,.+\sv1,.+$/);
    });
  });

  describe('verify', () => {
    it('should verify a valid signature', () => {
      const secret = Buffer.from('test-secret').toString('base64');
      const headers = signer.sign('evt_1', 1000, 'body', secret);

      const isValid = signer.verify(
        'evt_1',
        1000,
        'body',
        secret,
        headers['webhook-signature'],
      );

      expect(isValid).toBe(true);
    });

    it('should reject an invalid signature', () => {
      const secret = Buffer.from('test-secret').toString('base64');

      const isValid = signer.verify(
        'evt_1',
        1000,
        'body',
        secret,
        'v1,invalid_signature',
      );

      expect(isValid).toBe(false);
    });

    it('should reject a tampered payload', () => {
      const secret = Buffer.from('test-secret').toString('base64');
      const headers = signer.sign('evt_1', 1000, 'original', secret);

      const isValid = signer.verify(
        'evt_1',
        1000,
        'tampered',
        secret,
        headers['webhook-signature'],
      );

      expect(isValid).toBe(false);
    });

    it('should accept any valid signature from a multi-signature header', () => {
      const primary = Buffer.from('primary-secret').toString('base64');
      const secondary = Buffer.from('secondary-secret').toString('base64');
      const headers = signer.signAll('evt_1', 1000, 'body', [
        primary,
        secondary,
      ]);

      const secondarySignature = headers['webhook-signature'].split(' ')[1];
      const isValid = signer.verify(
        'evt_1',
        1000,
        'body',
        secondary,
        secondarySignature,
      );

      expect(isValid).toBe(true);
    });
  });

  describe('generateSecret', () => {
    it('should generate a base64-encoded secret', () => {
      const secret = signer.generateSecret();

      expect(secret).toBeTruthy();
      expect(() => Buffer.from(secret, 'base64')).not.toThrow();
      // 32 bytes → 44 chars in base64
      expect(Buffer.from(secret, 'base64').length).toBe(32);
    });

    it('should generate unique secrets', () => {
      const s1 = signer.generateSecret();
      const s2 = signer.generateSecret();

      expect(s1).not.toBe(s2);
    });
  });
});
