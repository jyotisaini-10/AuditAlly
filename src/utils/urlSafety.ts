import dns from 'dns/promises';
import net from 'net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '[::]',
  '::1',
]);

const PRIVATE_RANGES = [
  // 10.x.x.x
  /^10\.\d+\.\d+\.\d+$/,
  // 172.16-31.x.x
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  // 192.168.x.x
  /^192\.168\.\d+\.\d+$/,
  // 127.x.x.x loopback
  /^127\.\d+\.\d+\.\d+$/,
  // 169.254.x.x link-local
  /^169\.254\.\d+\.\d+$/,
  // 0.x.x.x
  /^0\.\d+\.\d+\.\d+$/,
];

export function normalizeScanUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid URL: "${raw}"`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported');
  }

  return parsed.href;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    // Block loopback and link-local IPv6
    return ip === '::1' || ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd');
  }
  return PRIVATE_RANGES.some((re) => re.test(ip));
}

export async function isSafePublicUrl(
  url: string
): Promise<{ ok: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'Malformed URL' };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: `Scanning "${hostname}" is not allowed (private/loopback host)` };
  }

  // Reject bare IP addresses that are private
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      return { ok: false, reason: 'Scanning private IP ranges is not allowed (SSRF protection)' };
    }
    return { ok: true };
  }

  // Resolve hostname → check resolved IPs
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    for (const addr of addrs) {
      if (isPrivateIp(addr.address)) {
        return {
          ok: false,
          reason: `Hostname "${hostname}" resolves to a private IP address (SSRF protection)`,
        };
      }
    }
  } catch {
    // DNS failure → refuse (could be internal hostname)
    return { ok: false, reason: `Cannot resolve hostname "${hostname}"` };
  }

  return { ok: true };
}
