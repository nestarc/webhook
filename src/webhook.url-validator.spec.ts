import { validateWebhookUrl } from './webhook.url-validator';
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
  });

  describe('unparseable URL', () => {
    it('should reject garbage input', async () => {
      await expect(validateWebhookUrl('not-a-url')).rejects.toThrow('unable to parse');
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
  });

  describe('link-local / cloud metadata', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.0.1/hook',
    ])('should reject metadata IP %s', async (url) => {
      await expect(validateWebhookUrl(url)).rejects.toThrow();
    });
  });

  describe('zero address', () => {
    it('should reject 0.0.0.0', async () => {
      await expect(validateWebhookUrl('http://0.0.0.0/hook')).rejects.toThrow();
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
  });
});
