import * as net from 'net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

export function validateWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: unable to parse "${url}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid webhook URL: scheme must be http or https, got "${parsed.protocol}"`,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(
      `Invalid webhook URL: "${hostname}" is not allowed (loopback address)`,
    );
  }

  if (net.isIPv4(hostname)) {
    validateIPv4(hostname);
  } else if (net.isIPv6(hostname) || hostname.startsWith('[')) {
    const cleanIp = hostname.replace(/^\[|\]$/g, '');
    validateIPv6(cleanIp);
  }
}

function validateIPv4(ip: string): void {
  const parts = ip.split('.').map(Number);

  // 127.0.0.0/8 — loopback
  if (parts[0] === 127) {
    throw new Error(`Invalid webhook URL: "${ip}" is a loopback address`);
  }
  // 10.0.0.0/8 — private class A
  if (parts[0] === 10) {
    throw new Error(`Invalid webhook URL: "${ip}" is a private address`);
  }
  // 172.16.0.0/12 — private class B
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    throw new Error(`Invalid webhook URL: "${ip}" is a private address`);
  }
  // 192.168.0.0/16 — private class C
  if (parts[0] === 192 && parts[1] === 168) {
    throw new Error(`Invalid webhook URL: "${ip}" is a private address`);
  }
  // 169.254.0.0/16 — link-local / cloud metadata
  if (parts[0] === 169 && parts[1] === 254) {
    throw new Error(
      `Invalid webhook URL: "${ip}" is a link-local/metadata address`,
    );
  }
  // 0.0.0.0
  if (parts[0] === 0) {
    throw new Error(`Invalid webhook URL: "${ip}" is not a valid target`);
  }
}

function validateIPv6(ip: string): void {
  // ::1 — loopback
  if (ip === '::1') {
    throw new Error(`Invalid webhook URL: "${ip}" is a loopback address`);
  }
  // fc00::/7 — unique local (private)
  const firstSegment = ip.split(':')[0].toLowerCase();
  if (firstSegment.startsWith('fc') || firstSegment.startsWith('fd')) {
    throw new Error(`Invalid webhook URL: "${ip}" is a private address`);
  }
  // fe80::/10 — link-local
  if (firstSegment.startsWith('fe8') || firstSegment.startsWith('fe9') ||
      firstSegment.startsWith('fea') || firstSegment.startsWith('feb')) {
    throw new Error(`Invalid webhook URL: "${ip}" is a link-local address`);
  }
}
