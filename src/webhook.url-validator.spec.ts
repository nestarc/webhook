import {
  validateWebhookUrl,
  WebhookUrlValidationError,
  type WebhookUrlValidationReason,
} from './webhook.url-validator';
import * as dns from 'dns';

// Mock dns.promises for DNS resolution tests
jest.mock('dns', () => ({
  promises: {
    resolve4: jest.fn(),
    resolve6: jest.fn(),
  },
}));

const mockResolve4 = dns.promises.resolve4 as jest.Mock;
const mockResolve6 = dns.promises.resolve6 as jest.Mock;

beforeEach(() => {
  // Default: hostname resolves to public IP
  mockResolve4.mockResolvedValue(['203.0.113.50']);
  mockResolve6.mockRejectedValue(new Error('ENODATA'));
});

async function expectReason(
  url: string,
  reason: WebhookUrlValidationReason,
): Promise<WebhookUrlValidationError> {
  try {
    await validateWebhookUrl(url);
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookUrlValidationError);
    const e = err as WebhookUrlValidationError;
    expect(e.reason).toBe(reason);
    return e;
  }
  throw new Error(`Expected validateWebhookUrl(${url}) to throw`);
}

describe('validateWebhookUrl', () => {
  describe('valid URLs', () => {
    it.each([
      'https://customer.com/webhooks',
      'https://api.example.com:8443/hooks',
      'http://webhooks.example.org/v1',
      'https://203.0.113.50/callback',
    ])('should accept %s', async (url) => {
      await expect(validateWebhookUrl(url)).resolves.not.toThrow();
    });
  });

  describe('invalid scheme', () => {
    it.each([
      'ftp://example.com/hook',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ])('should reject %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow('scheme must be http or https');
    });

    it('should set reason="scheme"', async () => {
      await expectReason('ftp://example.com/hook', 'scheme');
    });
  });

  describe('unparseable URL', () => {
    it('should reject garbage input', async () => {
      await expect(validateWebhookUrl('not-a-url')).rejects.toThrow('unable to parse');
    });

    it('should set reason="parse"', async () => {
      await expectReason('not-a-url', 'parse');
    });
  });

  describe('loopback addresses', () => {
    it.each([
      'http://localhost/hook',
      'http://127.0.0.1/hook',
      'http://127.0.0.254/hook',
      'http://[::1]/hook',
    ])('should reject %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow();
    });

    it('should set reason="blocked_hostname" for localhost', async () => {
      await expectReason('http://localhost/hook', 'blocked_hostname');
    });

    it('should set reason="loopback" for 127.0.0.1', async () => {
      const e = await expectReason('http://127.0.0.1/hook', 'loopback');
      expect(e.resolvedIp).toBe('127.0.0.1');
    });

    it('should set reason="loopback" for [::1]', async () => {
      await expectReason('http://[::1]/hook', 'loopback');
    });
  });

  describe('private networks', () => {
    it.each([
      'http://10.0.0.1/hook',
      'http://10.255.255.255/hook',
      'http://172.16.0.1/hook',
      'http://172.31.255.255/hook',
      'http://192.168.0.1/hook',
      'http://192.168.1.100/hook',
    ])('should reject private IP %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow('private address');
    });

    it('should set reason="private"', async () => {
      const e = await expectReason('http://10.0.0.1/hook', 'private');
      expect(e.resolvedIp).toBe('10.0.0.1');
      expect(e.url).toBe('http://10.0.0.1/hook');
    });
  });

  describe('link-local / cloud metadata', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.0.1/hook',
    ])('should reject metadata IP %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow();
    });

    it('should set reason="link_local"', async () => {
      await expectReason('http://169.254.169.254/', 'link_local');
    });
  });

  describe('zero address', () => {
    it('should reject 0.0.0.0', async () => {
      await expect(validateWebhookUrl('http://0.0.0.0/hook')).rejects.toThrow();
    });

    it('should set reason="invalid_target"', async () => {
      await expectReason('http://0.0.0.0/hook', 'invalid_target');
    });
  });

  describe('IPv6 private', () => {
    it.each([
      'http://[fc00::1]/hook',
      'http://[fd12:3456::1]/hook',
      'http://[fe80::1]/hook',
    ])('should reject IPv6 private %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow();
    });

    it('should set reason="private" for fc00::', async () => {
      await expectReason('http://[fc00::1]/hook', 'private');
    });

    it('should set reason="link_local" for fe80::', async () => {
      await expectReason('http://[fe80::1]/hook', 'link_local');
    });
  });

  describe('IPv4-mapped IPv6 bypass', () => {
    it('should reject ::ffff:127.0.0.1', async () => {
      await expect(
        validateWebhookUrl('http://[::ffff:127.0.0.1]/hook'),
      ).rejects.toThrow('loopback');
    });

    it('should reject ::ffff:10.0.0.1', async () => {
      await expect(
        validateWebhookUrl('http://[::ffff:10.0.0.1]/hook'),
      ).rejects.toThrow('private');
    });

    it('should reject ::ffff:169.254.169.254', async () => {
      await expect(
        validateWebhookUrl('http://[::ffff:169.254.169.254]/hook'),
      ).rejects.toThrow();
    });

    it('should set reason="loopback" for ::ffff:127.0.0.1', async () => {
      await expectReason('http://[::ffff:127.0.0.1]/hook', 'loopback');
    });
  });

  describe('DNS resolution bypass', () => {
    it('should reject hostname that resolves to private IP', async () => {
      mockResolve4.mockResolvedValueOnce(['10.0.0.1']);
      mockResolve6.mockRejectedValueOnce(new Error('ENODATA'));

      await expect(
        validateWebhookUrl('http://evil.nip.io/hook'),
      ).rejects.toThrow('private');
    });

    it('should reject hostname that resolves to loopback', async () => {
      mockResolve4.mockResolvedValueOnce(['127.0.0.1']);
      mockResolve6.mockRejectedValueOnce(new Error('ENODATA'));

      await expect(
        validateWebhookUrl('http://customer.127.0.0.1.nip.io/hook'),
      ).rejects.toThrow('loopback');
    });

    it('should reject hostname that resolves to metadata IP', async () => {
      mockResolve4.mockResolvedValueOnce(['169.254.169.254']);
      mockResolve6.mockRejectedValueOnce(new Error('ENODATA'));

      await expect(
        validateWebhookUrl('http://metadata.evil.com/hook'),
      ).rejects.toThrow();
    });

    it('should accept hostname resolving to public IP', async () => {
      mockResolve4.mockResolvedValueOnce(['203.0.113.50']);
      mockResolve6.mockRejectedValueOnce(new Error('ENODATA'));

      await expect(
        validateWebhookUrl('https://customer.com/hook'),
      ).resolves.not.toThrow();
    });

    it('should set reason="private" with resolvedIp when DNS bypass detected', async () => {
      mockResolve4.mockResolvedValueOnce(['10.0.0.1']);
      mockResolve6.mockRejectedValueOnce(new Error('ENODATA'));

      const e = await expectReason('http://evil.nip.io/hook', 'private');
      expect(e.resolvedIp).toBe('10.0.0.1');
      expect(e.url).toBe('http://evil.nip.io/hook');
    });
  });

  describe('WebhookUrlValidationError class', () => {
    it('should be an instance of Error (backward compat)', async () => {
      try {
        await validateWebhookUrl('not-a-url');
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(WebhookUrlValidationError);
      }
    });

    it('should expose name="WebhookUrlValidationError"', async () => {
      try {
        await validateWebhookUrl('ftp://example.com/hook');
      } catch (err) {
        expect((err as Error).name).toBe('WebhookUrlValidationError');
      }
    });
  });
});
