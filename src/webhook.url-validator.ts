import * as net from 'net';
import * as dns from 'dns';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

export type WebhookUrlValidationReason =
  | 'parse'
  | 'scheme'
  | 'blocked_hostname'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'invalid_target';

export class WebhookUrlValidationError extends Error {
  readonly name = 'WebhookUrlValidationError';
  readonly reason: WebhookUrlValidationReason;
  readonly url?: string;
  readonly resolvedIp?: string;

  constructor(
    message: string,
    reason: WebhookUrlValidationReason,
    url?: string,
    resolvedIp?: string,
  ) {
    super(message);
    this.reason = reason;
    this.url = url;
    this.resolvedIp = resolvedIp;
    Object.setPrototypeOf(this, WebhookUrlValidationError.prototype);
  }
}

export async function validateWebhookUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: unable to parse "${url}"`,
      'parse',
      url,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: scheme must be http or https, got "${parsed.protocol}"`,
      'scheme',
      url,
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${hostname}" is not allowed (loopback address)`,
      'blocked_hostname',
      url,
    );
  }

  if (net.isIPv4(hostname)) {
    validateIPv4(hostname, url);
  } else if (net.isIPv6(hostname) || hostname.startsWith('[')) {
    const cleanIp = hostname.replace(/^\[|\]$/g, '');
    validateIPv6(cleanIp, url);
  } else {
    // Hostname — resolve DNS and validate all resolved IPs
    await resolveAndValidateHost(hostname, url);
  }
}

function validateIPv4(ip: string, url?: string): void {
  const parts = ip.split('.').map(Number);

  if (parts[0] === 127) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a loopback address`,
      'loopback',
      url,
      ip,
    );
  }
  if (parts[0] === 10) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a private address`,
      'private',
      url,
      ip,
    );
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a private address`,
      'private',
      url,
      ip,
    );
  }
  if (parts[0] === 192 && parts[1] === 168) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a private address`,
      'private',
      url,
      ip,
    );
  }
  if (parts[0] === 169 && parts[1] === 254) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a link-local/metadata address`,
      'link_local',
      url,
      ip,
    );
  }
  if (parts[0] === 0) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is not a valid target`,
      'invalid_target',
      url,
      ip,
    );
  }
}

function validateIPv6(ip: string, url?: string): void {
  if (ip === '::1') {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a loopback address`,
      'loopback',
      url,
      ip,
    );
  }

  const lowerIp = ip.toLowerCase();

  // IPv4-mapped IPv6 — ::ffff:x.x.x.x or ::ffff:HHHH:HHHH (hex form)
  if (lowerIp.startsWith('::ffff:') || lowerIp.startsWith('0:0:0:0:0:ffff:')) {
    const suffix = lowerIp.replace(/^(::ffff:|0:0:0:0:0:ffff:)/, '');
    let ipv4: string;

    if (net.isIPv4(suffix)) {
      // ::ffff:10.0.0.1 form
      ipv4 = suffix;
    } else {
      // ::ffff:a00:1 form (hex) — convert to IPv4
      const hexParts = suffix.split(':');
      if (hexParts.length === 2) {
        const hi = parseInt(hexParts[0], 16);
        const lo = parseInt(hexParts[1], 16);
        ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      } else {
        return; // Unknown format, let it through (conservative)
      }
    }

    validateIPv4(ipv4, url);
    return;
  }

  const firstSegment = ip.split(':')[0].toLowerCase();
  if (firstSegment.startsWith('fc') || firstSegment.startsWith('fd')) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a private address`,
      'private',
      url,
      ip,
    );
  }
  if (firstSegment.startsWith('fe8') || firstSegment.startsWith('fe9') ||
      firstSegment.startsWith('fea') || firstSegment.startsWith('feb')) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is a link-local address`,
      'link_local',
      url,
      ip,
    );
  }
}

export async function resolveAndValidateHost(
  hostname: string,
  url?: string,
): Promise<void> {
  let addresses: string[] = [];

  try {
    const ipv4 = await dns.promises.resolve4(hostname);
    addresses = addresses.concat(ipv4);
  } catch {
    // No A record — not an error yet
  }

  try {
    const ipv6 = await dns.promises.resolve6(hostname);
    addresses = addresses.concat(ipv6);
  } catch {
    // No AAAA record — not an error yet
  }

  for (const ip of addresses) {
    if (net.isIPv4(ip)) {
      validateIPv4(ip, url); // throws if private
    } else if (net.isIPv6(ip)) {
      validateIPv6(ip, url); // throws if private
    }
  }
}
