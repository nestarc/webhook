import * as net from 'net';
import * as dns from 'dns';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

interface BlockedRange<T> {
  base: T;
  prefix: number;
  reason: WebhookUrlValidationReason;
  description: string;
}

export type WebhookUrlValidationReason =
  | 'parse'
  | 'scheme'
  | 'blocked_hostname'
  | 'loopback'
  | 'private'
  | 'link_local'
  | 'invalid_target';

const BLOCKED_IPV4_RANGES: Array<BlockedRange<number>> = [
  ipv4Range('0.0.0.0', 8, 'invalid_target', 'not a valid public target'),
  ipv4Range('10.0.0.0', 8, 'private', 'a private address'),
  ipv4Range('100.64.0.0', 10, 'private', 'a shared/private address'),
  ipv4Range('127.0.0.0', 8, 'loopback', 'a loopback address'),
  ipv4Range('169.254.0.0', 16, 'link_local', 'a link-local/metadata address'),
  ipv4Range('172.16.0.0', 12, 'private', 'a private address'),
  ipv4Range('192.0.0.0', 24, 'invalid_target', 'a special-use address'),
  ipv4Range('192.0.2.0', 24, 'invalid_target', 'a documentation address'),
  ipv4Range('192.88.99.0', 24, 'invalid_target', 'a special-use address'),
  ipv4Range('192.168.0.0', 16, 'private', 'a private address'),
  ipv4Range('198.18.0.0', 15, 'invalid_target', 'a benchmarking address'),
  ipv4Range('198.51.100.0', 24, 'invalid_target', 'a documentation address'),
  ipv4Range('203.0.113.0', 24, 'invalid_target', 'a documentation address'),
  ipv4Range('224.0.0.0', 4, 'invalid_target', 'a multicast address'),
  ipv4Range('240.0.0.0', 4, 'invalid_target', 'a reserved address'),
];

const BLOCKED_IPV6_RANGES: Array<BlockedRange<bigint>> = [
  ipv6Range('::', 128, 'invalid_target', 'not a valid public target'),
  ipv6Range('::1', 128, 'loopback', 'a loopback address'),
  ipv6Range('::', 96, 'invalid_target', 'a special-use address'),
  ipv6Range('100::', 64, 'invalid_target', 'a discard-only address'),
  ipv6Range('2001::', 23, 'invalid_target', 'a special-use address'),
  ipv6Range('2001:db8::', 32, 'invalid_target', 'a documentation address'),
  ipv6Range('2002::', 16, 'invalid_target', 'a special-use address'),
  ipv6Range('3fff::', 20, 'invalid_target', 'a documentation address'),
  ipv6Range('fc00::', 7, 'private', 'a private address'),
  ipv6Range('fe80::', 10, 'link_local', 'a link-local address'),
  ipv6Range('ff00::', 8, 'invalid_target', 'a multicast address'),
];

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
  const value = ipv4ToNumber(ip);
  const blocked = BLOCKED_IPV4_RANGES.find((range) =>
    ipv4InRange(value, range),
  );

  if (blocked) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is ${blocked.description}`,
      blocked.reason,
      url,
      ip,
    );
  }
}

function validateIPv6(ip: string, url?: string): void {
  const lowerIp = ip.toLowerCase();
  const parsed = parseIPv6ToBigInt(lowerIp);
  if (parsed === null) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is not a valid target`,
      'invalid_target',
      url,
      ip,
    );
  }

  if (isIPv4MappedIPv6(parsed)) {
    validateIPv4(numberToIPv4(Number(parsed & 0xffffffffn)), url);
    return;
  }

  const blocked = BLOCKED_IPV6_RANGES.find((range) =>
    ipv6InRange(parsed, range),
  );
  if (blocked) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${ip}" is ${blocked.description}`,
      blocked.reason,
      url,
      ip,
    );
  }
}

export async function resolveAndValidateHost(
  hostname: string,
  url?: string,
): Promise<string[]> {
  const cleanHostname = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (BLOCKED_HOSTNAMES.has(cleanHostname)) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: "${cleanHostname}" is not allowed (loopback address)`,
      'blocked_hostname',
      url,
    );
  }

  if (net.isIPv4(cleanHostname)) {
    validateIPv4(cleanHostname, url);
    return [cleanHostname];
  }

  if (net.isIPv6(cleanHostname)) {
    validateIPv6(cleanHostname, url);
    return [cleanHostname];
  }

  let addresses: string[] = [];

  try {
    const ipv4 = await dns.promises.resolve4(cleanHostname);
    addresses = addresses.concat(ipv4);
  } catch {
    // No A record — not an error yet
  }

  try {
    const ipv6 = await dns.promises.resolve6(cleanHostname);
    addresses = addresses.concat(ipv6);
  } catch {
    // No AAAA record — not an error yet
  }

  if (addresses.length === 0) {
    throw new WebhookUrlValidationError(
      `Invalid webhook URL: hostname "${cleanHostname}" did not resolve to any address`,
      'invalid_target',
      url,
    );
  }

  for (const ip of addresses) {
    if (net.isIPv4(ip)) {
      validateIPv4(ip, url); // throws if private
    } else if (net.isIPv6(ip)) {
      validateIPv6(ip, url); // throws if private
    }
  }

  return addresses;
}

function ipv4Range(
  base: string,
  prefix: number,
  reason: WebhookUrlValidationReason,
  description: string,
): BlockedRange<number> {
  return { base: ipv4ToNumber(base), prefix, reason, description };
}

function ipv6Range(
  base: string,
  prefix: number,
  reason: WebhookUrlValidationReason,
  description: string,
): BlockedRange<bigint> {
  const parsed = parseIPv6ToBigInt(base);
  if (parsed === null) {
    throw new Error(`Invalid IPv6 range base: ${base}`);
  }
  return { base: parsed, prefix, reason, description };
}

function ipv4ToNumber(ip: string): number {
  return ip
    .split('.')
    .map(Number)
    .reduce((value, part) => ((value << 8) + part) >>> 0, 0);
}

function numberToIPv4(value: number): string {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
}

function ipv4InRange(value: number, range: BlockedRange<number>): boolean {
  const mask = range.prefix === 0
    ? 0
    : (0xffffffff << (32 - range.prefix)) >>> 0;
  return (value & mask) >>> 0 === (range.base & mask) >>> 0;
}

function ipv6InRange(value: bigint, range: BlockedRange<bigint>): boolean {
  const shift = BigInt(128 - range.prefix);
  return (value >> shift) === (range.base >> shift);
}

function parseIPv6ToBigInt(ip: string): bigint | null {
  let normalized = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const zoneIndex = normalized.indexOf('%');
  if (zoneIndex !== -1) {
    normalized = normalized.slice(0, zoneIndex);
  }

  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = normalized.slice(lastColon + 1);
    if (!net.isIPv4(ipv4)) {
      return null;
    }
    const value = ipv4ToNumber(ipv4);
    const high = ((value >>> 16) & 0xffff).toString(16);
    const low = (value & 0xffff).toString(16);
    normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
  }

  const compressed = normalized.includes('::');
  const compressionParts = normalized.split('::');
  if (compressionParts.length > 2) {
    return null;
  }

  const left = compressionParts[0]
    ? compressionParts[0].split(':').filter((part) => part.length > 0)
    : [];
  const right = compressionParts[1]
    ? compressionParts[1].split(':').filter((part) => part.length > 0)
    : [];
  const missing = compressed ? 8 - left.length - right.length : 0;
  if (missing < 0) {
    return null;
  }

  const parts = compressed
    ? [...left, ...Array<string>(missing).fill('0'), ...right]
    : left;
  if (parts.length !== 8) {
    return null;
  }

  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) {
      return null;
    }
    value = (value << 16n) + BigInt(parseInt(part, 16));
  }
  return value;
}

function isIPv4MappedIPv6(value: bigint): boolean {
  return (value >> 32n) === 0xffffn;
}
