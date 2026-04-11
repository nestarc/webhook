import { validateWebhookUrl } from './webhook.url-validator';

describe('validateWebhookUrl', () => {
  describe('valid URLs', () => {
    it.each([
      'https://customer.com/webhooks',
      'https://api.example.com:8443/hooks',
      'http://webhooks.example.org/v1',
      'https://203.0.113.50/callback',
    ])('should accept %s', (url) => {
      expect(() => validateWebhookUrl(url)).not.toThrow();
    });
  });

  describe('invalid scheme', () => {
    it.each([
      'ftp://example.com/hook',
      'javascript:alert(1)',
      'file:///etc/passwd',
    ])('should reject %s', (url) => {
      expect(() => validateWebhookUrl(url)).toThrow('scheme must be http or https');
    });
  });

  describe('unparseable URL', () => {
    it('should reject garbage input', () => {
      expect(() => validateWebhookUrl('not-a-url')).toThrow('unable to parse');
    });
  });

  describe('loopback addresses', () => {
    it.each([
      'http://localhost/hook',
      'http://127.0.0.1/hook',
      'http://127.0.0.254/hook',
      'http://[::1]/hook',
    ])('should reject %s', (url) => {
      expect(() => validateWebhookUrl(url)).toThrow();
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
    ])('should reject private IP %s', (url) => {
      expect(() => validateWebhookUrl(url)).toThrow('private address');
    });
  });

  describe('link-local / cloud metadata', () => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://169.254.0.1/hook',
    ])('should reject metadata IP %s', (url) => {
      expect(() => validateWebhookUrl(url)).toThrow();
    });
  });

  describe('zero address', () => {
    it('should reject 0.0.0.0', () => {
      expect(() => validateWebhookUrl('http://0.0.0.0/hook')).toThrow();
    });
  });

  describe('IPv6 private', () => {
    it.each([
      'http://[fc00::1]/hook',
      'http://[fd12:3456::1]/hook',
      'http://[fe80::1]/hook',
    ])('should reject IPv6 private %s', (url) => {
      expect(() => validateWebhookUrl(url)).toThrow();
    });
  });
});
